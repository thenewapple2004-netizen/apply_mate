"""Onboarding flow: state, review of only missing/unconfirmed details, and merging."""

import pytest
from fastapi.testclient import TestClient

from app.modules.cv.contact import clean_contact
from app.modules.cv.schemas import CVExtraction
from tests.samples import SAMPLE_DOCX_PARAGRAPHS, SAMPLE_PDF_PAGES, make_docx, make_pdf
from tests.test_cv import ARSLAN_EXTRACTION, FakeProvider, ai  # noqa: F401  (fixture)

PDF = make_pdf(
    [["Arslan Khan", "arslan@example.com | +92 300 1234567 | linkedin.com/in/arslankhan"]] + SAMPLE_PDF_PAGES
)
DOCX = make_docx(SAMPLE_DOCX_PARAGRAPHS)
WITH_CONTACT = {
    **ARSLAN_EXTRACTION,
    "contact": {
        "full_name": "Arslan Khan",
        "email": "arslan@example.com",
        "phone": "+92 300 1234567",
        "location": "Lahore, Pakistan",
        "linkedin_url": "linkedin.com/in/arslankhan",
    },
}


def state(client: TestClient, pid: str) -> dict:
    response = client.get(f"/api/v1/profiles/{pid}/onboarding")
    assert response.status_code == 200, response.text
    return response.json()


def confirm(client: TestClient, pid: str, body: dict) -> dict:
    response = client.post(f"/api/v1/profiles/{pid}/onboarding/confirm", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def upload(client: TestClient, pid: str, name: str, data: bytes, primary=True) -> str:
    rid = client.post(f"/api/v1/profiles/{pid}/resumes", files={"file": (name, data)}).json()["id"]
    if primary:
        client.put(f"/api/v1/profiles/{pid}/resumes/{rid}/primary")
    return rid


def analyze(client: TestClient, pid: str, rid: str) -> dict:
    response = client.post(f"/api/v1/profiles/{pid}/resumes/{rid}/analysis", json={"consent": True})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def pid(db_client: TestClient) -> str:
    return db_client.post("/api/v1/profiles", json={"full_name": "Arslan Khan"}).json()["id"]


# --- steps ----------------------------------------------------------------------


def test_new_profile_starts_at_resume_step(db_client: TestClient, pid: str) -> None:
    s = state(db_client, pid)

    assert s["step"] == "resume" and s["resume"] is None and s["review"] is None


def test_after_upload_the_review_lists_everything_missing(db_client: TestClient, pid: str) -> None:
    upload(db_client, pid, "cv.pdf", PDF)

    s = state(db_client, pid)

    assert s["step"] == "review" and s["resume"]["original_filename"] == "cv.pdf"
    review = s["review"]
    assert review["contact_fields"] == ["email", "phone", "location", "linkedin_url"]
    assert review["contact"] == {f: None for f in review["contact_fields"]}  # no AI yet
    assert review["sections"] == [
        "summary", "skills", "technologies", "work_experience", "education", "projects", "certifications",
    ]
    assert review["source_analysis_id"] is None


def test_ai_suggestions_fill_the_review_including_contact(
    db_client: TestClient, ai: FakeProvider, pid: str
) -> None:
    rid = upload(db_client, pid, "cv.pdf", PDF)
    ai.outcome = WITH_CONTACT
    draft = analyze(db_client, pid, rid)

    review = state(db_client, pid)["review"]

    assert review["source_analysis_id"] == draft["id"]
    assert review["contact"] == {
        "email": "arslan@example.com",
        "phone": "+92 300 1234567",
        "location": "Lahore, Pakistan",
        "linkedin_url": "https://linkedin.com/in/arslankhan",  # scheme added so it validates
    }
    assert review["cv"]["education"][0]["institution"] == "LUMS"


def test_contact_fields_already_on_the_profile_are_not_asked_again(
    db_client: TestClient, ai: FakeProvider, pid: str
) -> None:
    db_client.patch(f"/api/v1/profiles/{pid}", json={"email": "mine@example.com", "location": "Karachi"})
    rid = upload(db_client, pid, "cv.pdf", PDF)
    ai.outcome = WITH_CONTACT
    analyze(db_client, pid, rid)

    review = state(db_client, pid)["review"]

    assert review["contact_fields"] == ["phone", "linkedin_url"]
    assert set(review["contact"]) == {"phone", "linkedin_url"}


def test_confirming_saves_profile_and_cv_and_completes_onboarding(
    db_client: TestClient, ai: FakeProvider, pid: str
) -> None:
    rid = upload(db_client, pid, "cv.pdf", PDF)
    ai.outcome = WITH_CONTACT
    draft = analyze(db_client, pid, rid)
    review = state(db_client, pid)["review"]
    cv = review["cv"]
    cv["work_experience"][0]["company"] = "Acme Payments"  # user correction
    cv["skills"] = ["API design"]                          # user addition

    s = confirm(db_client, pid, {
        "contact": {**review["contact"], "location": "Lahore"},
        "cv": cv,
        "source_analysis_id": draft["id"],
    })

    assert s["step"] == "complete" and s["review"] is None
    assert s["profile"]["email"] == "arslan@example.com" and s["profile"]["location"] == "Lahore"
    assert s["cv"]["work_experience"][0]["company"] == "Acme Payments"
    assert s["cv"]["skills"] == ["API design"]
    assert s["analysis"]["status"] == "confirmed"
    # Reopening shows the same completed state (no repeated onboarding).
    assert state(db_client, pid) == s


def test_manual_onboarding_without_ai(db_client: TestClient, pid: str) -> None:
    upload(db_client, pid, "cv.pdf", PDF)

    s = confirm(db_client, pid, {"contact": {"phone": "+92 300 0000000"}, "cv": {"skills": ["Excel"]}})

    assert s["step"] == "complete" and s["profile"]["phone"] == "+92 300 0000000"
    assert s["cv"]["skills"] == ["Excel"]


def test_confirm_with_nothing_still_completes(db_client: TestClient, pid: str) -> None:
    upload(db_client, pid, "cv.pdf", PDF)

    assert confirm(db_client, pid, {})["step"] == "complete"


def test_confirm_never_overwrites_existing_profile_values(db_client: TestClient, pid: str) -> None:
    db_client.patch(f"/api/v1/profiles/{pid}", json={"email": "mine@example.com"})
    upload(db_client, pid, "cv.pdf", PDF)

    s = confirm(db_client, pid, {"contact": {"email": "other@example.com"}})

    assert s["profile"]["email"] == "mine@example.com"


# --- replacing the resume: only new / unconfirmed items -------------------------


def test_new_resume_review_shows_only_unconfirmed_items_and_merges(
    db_client: TestClient, ai: FakeProvider, pid: str
) -> None:
    rid = upload(db_client, pid, "cv.pdf", PDF)
    ai.outcome = WITH_CONTACT
    first = analyze(db_client, pid, rid)
    confirmed = confirm(db_client, pid, {
        "contact": state(db_client, pid)["review"]["contact"],
        "cv": {**first["data"], "summary": "Backend engineer."},
        "source_analysis_id": first["id"],
    })["cv"]

    # Replace the resume; the new analysis repeats some facts and adds others.
    new_rid = upload(db_client, pid, "cv-2026.docx", DOCX)
    ai.outcome = {
        **WITH_CONTACT,
        "summary": "A different summary",
        "technologies": ["python", "Kubernetes"],  # "python" is already confirmed (case-insensitive)
        "work_experience": ARSLAN_EXTRACTION["work_experience"] + [
            {"company": "Beta Corp", "title": "Tech Lead", "start_date": "2024"}
        ],
        "certifications": [{"name": "CKA", "issuer": "CNCF"}],
    }
    second = analyze(db_client, pid, new_rid)
    s = state(db_client, pid)

    assert s["step"] == "complete" and s["resume"]["id"] == new_rid
    review = s["review"]
    assert review["contact_fields"] == []          # all contact details are on the profile
    assert "summary" not in review["sections"]     # confirmed summary is kept, not re-asked
    assert review["cv"]["technologies"] == ["Kubernetes"]
    assert [j["company"] for j in review["cv"]["work_experience"]] == ["Beta Corp"]
    assert review["cv"]["certifications"][0]["name"] == "CKA"
    assert "education" not in review["sections"]   # nothing new there

    after = confirm(db_client, pid, {"cv": review["cv"], "source_analysis_id": second["id"]})

    assert after["cv"]["summary"] == "Backend engineer."
    assert after["cv"]["technologies"] == confirmed["technologies"] + ["Kubernetes"]
    assert [j["company"] for j in after["cv"]["work_experience"]] == [None, "Beta Corp"]
    assert after["review"] is None


def test_unreviewed_draft_never_changes_confirmed_details(
    db_client: TestClient, ai: FakeProvider, pid: str
) -> None:
    rid = upload(db_client, pid, "cv.pdf", PDF)
    saved = confirm(db_client, pid, {"cv": {"skills": ["Excel"]}})["cv"]
    ai.outcome = WITH_CONTACT

    analyze(db_client, pid, rid)

    assert state(db_client, pid)["cv"] == saved


# --- validation and isolation -----------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"contact": {"email": "not-an-email"}},
        {"contact": {"linkedin_url": "https://evil.example.com/x"}},
        {"contact": {"full_name": "Someone Else"}},  # name isn't changed through onboarding
        {"cv": {"summary": "x" * 5001}},
        {"unexpected": True},
    ],
)
def test_invalid_submissions_are_rejected(db_client: TestClient, pid: str, body: dict) -> None:
    upload(db_client, pid, "cv.pdf", PDF)

    response = db_client.post(f"/api/v1/profiles/{pid}/onboarding/confirm", json=body)

    assert response.status_code == 422
    assert state(db_client, pid)["step"] == "review"


def test_profiles_are_isolated(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    other = db_client.post("/api/v1/profiles", json={"full_name": "Ahmed"}).json()["id"]
    rid = upload(db_client, pid, "cv.pdf", PDF)
    draft = analyze(db_client, pid, rid)

    # Ahmed can't confirm Arslan's draft, and sees none of Arslan's data.
    hijack = db_client.post(
        f"/api/v1/profiles/{other}/onboarding/confirm", json={"source_analysis_id": draft["id"]}
    )
    assert hijack.status_code == 404
    s = state(db_client, other)
    assert s["step"] == "resume" and s["cv"] is None and s["resume"] is None


def test_unknown_profile_returns_404(db_client: TestClient) -> None:
    missing = "00000000-0000-4000-8000-000000000000"

    assert db_client.get(f"/api/v1/profiles/{missing}/onboarding").status_code == 404
    assert db_client.post(f"/api/v1/profiles/{missing}/onboarding/confirm", json={}).status_code == 404


# --- contact suggestion cleaning --------------------------------------------------


def test_contact_suggestions_are_validated_and_checked_against_the_resume() -> None:
    extraction = CVExtraction.model_validate({
        "contact": {
            "email": "invented@example.com",
            "phone": "call me",                       # invalid: dropped
            "linkedin_url": "www.linkedin.com/in/ak",  # completed with https://
            "location": "Lahore",
        }
    })

    contact, warnings = clean_contact(extraction, "Arslan, Lahore. linkedin: ak")

    assert contact == {
        "email": "invented@example.com",
        "linkedin_url": "https://www.linkedin.com/in/ak",
        "location": "Lahore",
    }
    assert warnings == ['Email "invented@example.com" wasn\'t found in the resume text.']
