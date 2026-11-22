"""CV analysis and confirmed details, with the AI provider mocked."""

import logging
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.ai.errors import (
    AIInvalidResponse,
    AINotConfigured,
    AIQuotaExceeded,
    AITimeout,
    AIUnavailable,
)
from app.modules.ai.provider import StructuredResult, get_ai_provider
from app.modules.cv.schemas import CVExtraction
from tests.samples import SAMPLE_DOCX_PARAGRAPHS, SAMPLE_PDF_PAGES, make_docx, make_pdf

PDF = make_pdf(SAMPLE_PDF_PAGES)
DOCX = make_docx(SAMPLE_DOCX_PARAGRAPHS)

ARSLAN_EXTRACTION = {
    "summary": None,
    "skills": [],
    "technologies": ["Python", "FastAPI", "python"],  # duplicate (case) is removed
    "work_experience": [
        {
            "company": None,
            "title": "Senior Software Engineer",
            "location": "Lahore, Pakistan",
            "start_date": "2019",
            "end_date": "2024",
            "is_current": None,
            "responsibilities": ["Built payment APIs in Python and FastAPI (2019-2024).", " "],
        }
    ],
    "education": [
        {"institution": "LUMS", "degree": "BS Computer Science", "field_of_study": None,
         "start_date": None, "end_date": "2018", "details": []}
    ],
    "projects": [],
    "certifications": [],
}
AHMED_EXTRACTION = {
    "summary": None,
    "skills": ["SQL", "Python", "Power BI", "Tableau", "Excel"],
    "technologies": ["SQL", "Python", "Power BI", "Tableau", "Excel"],
    "work_experience": [{"title": "Data Analyst", "location": "Karachi, Pakistan", "responsibilities": []}],
}


class FakeProvider:
    name = "fake"

    def __init__(self) -> None:
        self.outcome: dict | Exception = ARSLAN_EXTRACTION
        self.prompts: list[str] = []

    def generate_structured(self, *, system, prompt, schema):
        self.prompts.append(prompt)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return StructuredResult(data=schema.model_validate(self.outcome), model="fake-model-1")


@pytest.fixture
def ai() -> FakeProvider:
    fake = FakeProvider()
    app.dependency_overrides[get_ai_provider] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_ai_provider, None)


def new_profile(client: TestClient, name: str) -> str:
    return client.post("/api/v1/profiles", json={"full_name": name}).json()["id"]


def upload(client: TestClient, pid: str, name: str, data: bytes) -> str:
    response = client.post(f"/api/v1/profiles/{pid}/resumes", files={"file": (name, data)})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def analyze(client: TestClient, pid: str, rid: str, consent=True):
    return client.post(f"/api/v1/profiles/{pid}/resumes/{rid}/analysis", json={"consent": consent})


def cv_url(pid: str) -> str:
    return f"/api/v1/profiles/{pid}/cv"


@pytest.fixture
def arslan(db_client: TestClient) -> tuple[str, str]:
    pid = new_profile(db_client, "Arslan")
    return pid, upload(db_client, pid, "arslan.pdf", PDF)


# --- analysis ---------------------------------------------------------------


def test_analyze_pdf_sends_extracted_text_and_stores_a_draft(
    db_client: TestClient, ai: FakeProvider, arslan
) -> None:
    pid, rid = arslan

    response = analyze(db_client, pid, rid)

    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft["status"] == "draft" and draft["confirmed_at"] is None
    assert draft["resume_id"] == rid and draft["provider"] == "fake" and draft["model"] == "fake-model-1"
    # The resume's own extracted text (both pages) was what the AI received.
    assert "Senior Software Engineer" in ai.prompts[0]
    assert "BS Computer Science, LUMS (2018)" in ai.prompts[0]
    data = draft["data"]
    assert data["technologies"] == ["Python", "FastAPI"]
    assert data["work_experience"][0]["responsibilities"] == [
        "Built payment APIs in Python and FastAPI (2019-2024)."
    ]
    # Missing facts stay missing.
    assert data["summary"] is None and data["work_experience"][0]["company"] is None
    assert data["projects"] == [] and data["certifications"] == []
    # Nothing was confirmed.
    assert db_client.get(cv_url(pid)).status_code == 404


def test_analyze_docx(db_client: TestClient, ai: FakeProvider) -> None:
    pid = new_profile(db_client, "Ahmed")
    rid = upload(db_client, pid, "ahmed.docx", DOCX)
    ai.outcome = AHMED_EXTRACTION

    response = analyze(db_client, pid, rid)

    assert response.status_code == 201
    assert "Data Analyst\tKarachi, Pakistan" in ai.prompts[0]
    assert response.json()["data"]["skills"] == ["SQL", "Python", "Power BI", "Tableau", "Excel"]
    assert response.json()["warnings"] == []


def test_get_draft_returns_latest_analysis(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, rid = arslan
    first = analyze(db_client, pid, rid).json()
    ai.outcome = {**ARSLAN_EXTRACTION, "skills": ["Leadership"]}

    second = analyze(db_client, pid, rid).json()
    fetched = db_client.get(f"/api/v1/profiles/{pid}/resumes/{rid}/analysis").json()

    assert second["id"] == first["id"]  # one current draft per resume
    assert fetched["data"]["skills"] == ["Leadership"]


def test_facts_not_in_resume_are_flagged(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, rid = arslan
    ai.outcome = {
        **ARSLAN_EXTRACTION,
        "work_experience": [{"company": "Google", "title": "Senior Software Engineer"}],
        "certifications": [{"name": "AWS Solutions Architect"}],
    }

    warnings = analyze(db_client, pid, rid).json()["warnings"]

    assert any('"Google"' in w for w in warnings)
    assert any('"AWS Solutions Architect"' in w for w in warnings)
    assert not any("Senior Software Engineer" in w for w in warnings)


def test_consent_is_required(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, rid = arslan

    assert analyze(db_client, pid, rid, consent=False).status_code == 422
    assert db_client.post(f"/api/v1/profiles/{pid}/resumes/{rid}/analysis", json={}).status_code == 422
    assert ai.prompts == []  # nothing was sent to the AI


def test_resume_without_text_is_not_sent(db_client: TestClient, ai: FakeProvider) -> None:
    pid = new_profile(db_client, "Scan")
    rid = upload(db_client, pid, "scan.pdf", make_pdf([[]]))

    response = analyze(db_client, pid, rid)

    assert response.status_code == 422 and "no readable text" in response.json()["detail"]
    assert ai.prompts == []


@pytest.mark.parametrize(
    ("error", "status", "fragment"),
    [
        (AIQuotaExceeded(), 429, "quota"),
        (AIUnavailable(), 503, "unavailable"),
        (AITimeout(), 504, "too long"),
        (AIInvalidResponse(), 502, "couldn't be read"),
        (AINotConfigured(), 503, "GEMINI_API_KEY"),
    ],
)
def test_ai_failures_return_clear_errors_and_store_nothing(
    db_client: TestClient, ai: FakeProvider, arslan, error, status: int, fragment: str
) -> None:
    pid, rid = arslan
    ai.outcome = error

    response = analyze(db_client, pid, rid)

    assert response.status_code == status
    assert fragment in response.json()["detail"]
    assert db_client.get(f"/api/v1/profiles/{pid}/resumes/{rid}/analysis").status_code == 404


def test_explicit_nulls_from_the_ai_are_accepted(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    """Real Gemini output uses explicit nulls (regression: a null project url caused a 500)."""
    pid, rid = arslan
    ai.outcome = {
        "contact": {"full_name": None, "email": None, "phone": None, "location": None, "linkedin_url": None},
        "summary": None,
        "skills": ["Python", None, ""],
        "technologies": None,  # a null list
        "work_experience": [{"company": None, "title": "Engineer", "location": None, "start_date": None,
                             "end_date": None, "is_current": None, "responsibilities": [None, "Built APIs"]}],
        "education": [{"institution": None, "degree": None, "field_of_study": None, "start_date": None,
                       "end_date": None, "details": []}],
        "projects": [{"name": "Payments", "role": None, "description": None, "technologies": [None], "url": None}],
        "certifications": [{"name": None, "issuer": None, "date": None}],
    }

    response = analyze(db_client, pid, rid)

    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["skills"] == ["Python"]
    assert data["work_experience"][0]["responsibilities"] == ["Built APIs"]
    assert data["projects"][0]["url"] is None and data["projects"][0]["technologies"] == []


def test_ai_output_outside_limits_is_an_invalid_response(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, rid = arslan
    ai.outcome = {**ARSLAN_EXTRACTION, "work_experience": [{"company": "x" * 5000}]}

    response = analyze(db_client, pid, rid)

    assert response.status_code == 502


# --- confirmation and editing ------------------------------------------------


def test_user_corrects_and_confirms_a_draft(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, rid = arslan
    draft = analyze(db_client, pid, rid).json()
    reviewed = draft["data"]
    reviewed["summary"] = "Backend engineer focused on payments."  # added by the user
    reviewed["work_experience"][0]["company"] = "Acme Payments"     # corrected by the user
    reviewed["certifications"] = [{"name": "Scrum Master", "issuer": "Scrum.org", "date": "2021"}]

    response = db_client.put(cv_url(pid), json={**reviewed, "source_analysis_id": draft["id"]})

    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["summary"] == "Backend engineer focused on payments."
    assert saved["work_experience"][0]["company"] == "Acme Payments"
    assert saved["certifications"][0]["issuer"] == "Scrum.org"
    assert saved["source_resume_id"] == rid and saved["source_analysis_id"] == draft["id"]
    assert db_client.get(cv_url(pid)).json() == saved
    status = db_client.get(f"/api/v1/profiles/{pid}/resumes/{rid}/analysis").json()
    assert status["status"] == "confirmed" and status["confirmed_at"]


def test_saved_details_can_be_edited_and_order_is_kept(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, _ = arslan
    jobs = [{"company": f"Company {i}", "title": "Engineer"} for i in range(3)]
    db_client.put(cv_url(pid), json={"work_experience": jobs, "skills": ["A"]})

    edited = db_client.put(cv_url(pid), json={"work_experience": jobs[::-1][:2], "skills": ["A", "B"]}).json()

    assert [j["company"] for j in edited["work_experience"]] == ["Company 2", "Company 1"]
    assert edited["skills"] == ["A", "B"]
    assert [j["company"] for j in db_client.get(cv_url(pid)).json()["work_experience"]] == ["Company 2", "Company 1"]


def test_new_analysis_does_not_overwrite_confirmed_details(
    db_client: TestClient, ai: FakeProvider, arslan
) -> None:
    pid, rid = arslan
    draft = analyze(db_client, pid, rid).json()
    confirmed = db_client.put(cv_url(pid), json={**draft["data"], "source_analysis_id": draft["id"]}).json()

    other = upload(db_client, pid, "second.docx", DOCX)
    ai.outcome = AHMED_EXTRACTION
    analyze(db_client, pid, other)
    analyze(db_client, pid, rid)

    assert db_client.get(cv_url(pid)).json() == confirmed


def test_invalid_edits_are_rejected(db_client: TestClient, arslan) -> None:
    pid, _ = arslan
    for body in [
        {"summary": "x" * 5001},
        {"skills": "not a list"},
        {"work_experience": [{"company": "A", "unexpected": True}]},
        {"education": [{"start_date": "x" * 51}]},
        {"unknown_field": 1},
    ]:
        assert db_client.put(cv_url(pid), json=body).status_code == 422, body
    assert db_client.get(cv_url(pid)).status_code == 404


def test_deleting_the_source_resume_keeps_confirmed_details(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, rid = arslan
    draft = analyze(db_client, pid, rid).json()
    db_client.put(cv_url(pid), json={**draft["data"], "source_analysis_id": draft["id"]})

    db_client.delete(f"/api/v1/profiles/{pid}/resumes/{rid}")

    saved = db_client.get(cv_url(pid)).json()
    assert saved["source_resume_id"] is None and saved["source_analysis_id"] is None
    assert saved["education"][0]["institution"] == "LUMS"


# --- separation between profiles ----------------------------------------------


def test_profiles_are_isolated(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    a_pid, a_rid = arslan
    b_pid = new_profile(db_client, "Ahmed")
    draft = analyze(db_client, a_pid, a_rid).json()
    db_client.put(cv_url(a_pid), json={**draft["data"], "source_analysis_id": draft["id"]})

    # B can't analyze, read A's draft, or confirm A's draft into itself.
    assert analyze(db_client, b_pid, a_rid).status_code == 404
    assert db_client.get(f"/api/v1/profiles/{b_pid}/resumes/{a_rid}/analysis").status_code == 404
    hijack = db_client.put(cv_url(b_pid), json={"source_analysis_id": draft["id"]})
    assert hijack.status_code == 404 and hijack.json() == {"detail": "Analysis not found"}
    # B has no details; A's are intact.
    assert db_client.get(cv_url(b_pid)).status_code == 404
    db_client.put(cv_url(b_pid), json={"skills": ["Excel"]})
    assert db_client.get(cv_url(a_pid)).json()["education"][0]["institution"] == "LUMS"
    assert db_client.get(cv_url(b_pid)).json()["education"] == []


def test_deleting_profile_removes_its_cv_data(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, rid = arslan
    draft = analyze(db_client, pid, rid).json()
    db_client.put(cv_url(pid), json={**draft["data"], "source_analysis_id": draft["id"]})

    assert db_client.delete(f"/api/v1/profiles/{pid}").status_code == 204
    assert db_client.get(cv_url(pid)).status_code == 404


def test_unknown_ids_return_404(db_client: TestClient, ai: FakeProvider, arslan) -> None:
    pid, _ = arslan
    missing = str(uuid.uuid4())

    assert analyze(db_client, pid, missing).json() == {"detail": "Resume not found"}
    assert analyze(db_client, missing, missing).json() == {"detail": "Profile not found"}
    assert db_client.get(cv_url(missing)).json() == {"detail": "Profile not found"}
    assert db_client.put(cv_url(missing), json={}).status_code == 404


# --- privacy ------------------------------------------------------------------


def test_logs_contain_no_resume_or_cv_content(
    db_client: TestClient, ai: FakeProvider, arslan, caplog: pytest.LogCaptureFixture
) -> None:
    pid, rid = arslan
    caplog.set_level(logging.DEBUG)

    draft = analyze(db_client, pid, rid).json()
    db_client.put(cv_url(pid), json={**draft["data"], "summary": "PRIVATE-SUMMARY", "source_analysis_id": draft["id"]})

    for secret in ("Senior Software Engineer", "LUMS", "PRIVATE-SUMMARY", "Lahore"):
        assert secret not in caplog.text
