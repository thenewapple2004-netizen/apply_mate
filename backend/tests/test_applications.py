"""Preparing application answers (AI mocked) and saved answers."""

import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.modules.ai.errors import AIQuotaExceeded
from tests.test_cv import FakeProvider, ai  # noqa: F401  (fixture)

JOB = {
    "title": "Backend Engineer (Python)",
    "company": "Nimbus Pay",
    "description": "Build REST APIs in Python (FastAPI) and PostgreSQL. 3+ years required.",
    "url": "http://127.0.0.1:8000/demo/apply.html",
}

FIELDS = [
    {"id": "f1", "label": "Full name *", "type": "text", "required": True},
    {"id": "f2", "label": "Email *", "type": "email", "required": True},
    {"id": "f3", "label": "Phone number *", "type": "tel", "required": True},
    {"id": "f4", "label": "LinkedIn profile", "type": "url"},
    {"id": "f5", "label": "Current city", "type": "text"},
    {"id": "f6", "label": "How many years of professional backend development experience do you have?", "type": "number"},
    {"id": "f7", "label": "Highest level of education", "type": "select", "options": [
        {"value": "high_school", "label": "High school"}, {"value": "bachelors", "label": "Bachelor's degree"},
        {"value": "masters", "label": "Master's degree"}]},
    {"id": "f8", "label": "Which of these technologies have you used professionally?", "type": "checkbox", "options": [
        {"value": "python", "label": "Python"}, {"value": "fastapi", "label": "FastAPI"},
        {"value": "kubernetes", "label": "Kubernetes"}]},
    {"id": "f9", "label": "Which work arrangement do you prefer?", "type": "radio", "options": [
        {"value": "onsite", "label": "On-site"}, {"value": "remote", "label": "Remote"}]},
    {"id": "f10", "label": "Are you legally authorized to work in Pakistan? *", "type": "radio", "options": [
        {"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}]},
    {"id": "f11", "label": "Why do you want to join Nimbus Pay? (cover letter)", "type": "textarea"},
    {"id": "f12", "label": "I agree to the Nimbus Pay privacy policy *", "type": "checkbox", "options": [
        {"value": "on", "label": "I agree to the Nimbus Pay privacy policy"}]},
]

AI_REPLY = {"answers": [
    {"field_id": "f6", "value": "5"},
    {"field_id": "f7", "value": "Bachelor's degree"},              # label -> mapped to option value
    {"field_id": "f8", "values": ["python", "FastAPI", "Rust"]},    # Rust isn't an option: dropped
    {"field_id": "f9", "value": None, "note": "No preference in your profile."},
    {"field_id": "f10", "value": "Yes"},
    {"field_id": "f11", "value": "I build payment APIs in Python and FastAPI..."},
    {"field_id": "f12", "values": ["on"]},                          # consent: never ticked
    {"field_id": "f1", "value": "Someone Else"},                    # already answered from profile: ignored
    {"field_id": "zzz", "value": "unknown field"},                  # not on the page: ignored
]}


@pytest.fixture
def pid(db_client: TestClient) -> str:
    pid = db_client.post("/api/v1/profiles", json={
        "full_name": "Arslan Khan", "email": "arslan@example.com", "phone": "+92 300 1234567",
        "location": "Lahore, Pakistan", "linkedin_url": "https://www.linkedin.com/in/arslankhan",
    }).json()["id"]
    db_client.put(f"/api/v1/profiles/{pid}/cv", json={
        "skills": ["API design"], "technologies": ["Python", "FastAPI", "PostgreSQL"],
        "work_experience": [{"title": "Senior Software Engineer", "company": "Acme", "start_date": "2019", "end_date": "2024"}],
        "education": [{"institution": "LUMS", "degree": "BS Computer Science"}],
    })
    return pid


def prepare(client: TestClient, pid: str, fields=FIELDS, job=JOB):
    return client.post(f"/api/v1/profiles/{pid}/applications/answers", json={"job": job, "fields": fields})


def by_id(response) -> dict:
    return {a["field_id"]: a for a in response.json()["answers"]}


def test_contact_fields_come_from_the_profile(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = AI_REPLY
    a = by_id(prepare(db_client, pid))

    assert a["f1"] == {**a["f1"], "value": "Arslan Khan", "source": "profile"}
    assert a["f2"]["value"] == "arslan@example.com" and a["f2"]["source"] == "profile"
    assert a["f3"]["value"] == "+92 300 1234567"
    assert a["f4"]["value"] == "https://www.linkedin.com/in/arslankhan"
    assert a["f5"]["value"] == "Lahore, Pakistan"


def test_ai_answers_are_checked_against_the_page(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = AI_REPLY
    response = prepare(db_client, pid)
    a = by_id(response)

    assert response.json()["ai_used"] is True and response.json()["ai_error"] is None
    assert [x["field_id"] for x in response.json()["answers"]] == [f["id"] for f in FIELDS]  # page order
    assert a["f6"] == {**a["f6"], "value": "5", "source": "ai"}
    assert a["f7"]["value"] == "bachelors"
    assert a["f8"]["values"] == ["python", "fastapi"]
    assert a["f9"]["value"] is None and a["f9"]["note"] == "No preference in your profile."
    assert a["f10"]["value"] == "yes"
    assert a["f11"]["value"].startswith("I build payment APIs")
    assert a["f12"]["values"] == [] and a["f12"]["source"] == "none" and "yourself" in a["f12"]["note"]


def test_the_ai_only_receives_unanswered_fields_and_real_data(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": []}
    prepare(db_client, pid)

    prompt = ai.prompts[0]
    fields = json.loads(prompt.split("<fields>\n")[1].split("\n</fields>")[0])
    assert [f["id"] for f in fields] == ["f6", "f7", "f8", "f9", "f10", "f11", "f12"]
    assert "Nimbus Pay" in prompt and "Senior Software Engineer" in prompt and "LUMS" in prompt


def test_choice_not_among_options_is_dropped(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": [{"field_id": "f7", "value": "PhD"}]}

    a = by_id(prepare(db_client, pid))

    assert a["f7"]["value"] is None and a["f7"]["source"] == "none"


def test_ai_failure_still_returns_profile_answers(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = AIQuotaExceeded()

    response = prepare(db_client, pid)

    body = response.json()
    assert response.status_code == 200
    assert body["ai_used"] is False and "quota" in body["ai_error"]
    a = by_id(response)
    assert a["f2"]["value"] == "arslan@example.com"
    assert a["f11"]["source"] == "none"


def test_no_ai_call_when_everything_is_known(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    response = prepare(db_client, pid, fields=FIELDS[:5])

    assert ai.prompts == [] and response.json()["ai_used"] is False


def test_missing_profile_values_are_left_blank(db_client: TestClient, ai: FakeProvider) -> None:
    pid = db_client.post("/api/v1/profiles", json={"full_name": "Sara"}).json()["id"]
    ai.outcome = {"answers": [{"field_id": "f2", "value": None, "note": "No email in your profile."}]}

    a = by_id(prepare(db_client, pid, fields=FIELDS[1:3]))

    assert a["f2"]["value"] is None and a["f2"]["source"] == "none"
    assert a["f3"]["value"] is None


def test_first_and_last_name_split(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    fields = [
        {"id": "a", "label": "First name", "type": "text"},
        {"id": "b", "label": "Last name", "type": "text"},
        {"id": "c", "label": "Company name", "type": "text"},
    ]
    ai.outcome = {"answers": []}

    a = by_id(prepare(db_client, pid, fields=fields))

    assert a["a"]["value"] == "Arslan" and a["b"]["value"] == "Khan"
    assert a["c"]["source"] == "none"  # not mistaken for the applicant's name


# --- saved answers -------------------------------------------------------------------


def test_saved_answers_are_reused_before_asking_the_ai(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    saved = db_client.put(f"/api/v1/profiles/{pid}/answers", json={"answers": [
        {"question": "Are you legally authorized to work in Pakistan?", "answer": "Yes"},
        {"question": "Which work arrangement do you prefer?", "answer": "Remote"},
        {"question": "Which of these technologies have you used professionally?", "answer": "Python; Kubernetes"},
        {"question": "Notice period", "answer": "1 month"},
    ]})
    assert saved.json() == {"saved": 4}
    ai.outcome = {"answers": []}

    a = by_id(prepare(db_client, pid))

    assert a["f10"] == {**a["f10"], "value": "yes", "source": "saved"}   # matched despite the "*"
    assert a["f9"]["value"] == "remote" and a["f9"]["source"] == "saved"
    assert a["f8"]["values"] == ["python", "kubernetes"]
    fields_sent = ai.prompts[0].split("<fields>")[1]
    assert '"f10"' not in fields_sent and '"f9"' not in fields_sent


def test_saving_the_same_question_updates_it(db_client: TestClient, pid: str) -> None:
    db_client.put(f"/api/v1/profiles/{pid}/answers", json={"answers": [{"question": "Notice period", "answer": "1 month"}]})
    db_client.put(f"/api/v1/profiles/{pid}/answers", json={"answers": [{"question": "Notice period *", "answer": "2 weeks"}]})

    listed = db_client.get(f"/api/v1/profiles/{pid}/answers").json()

    assert listed == [{"question": "Notice period *", "answer": "2 weeks"}]


def test_saved_answers_are_per_profile(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    other = db_client.post("/api/v1/profiles", json={"full_name": "Ahmed"}).json()["id"]
    db_client.put(f"/api/v1/profiles/{pid}/answers", json={"answers": [
        {"question": "Are you legally authorized to work in Pakistan?", "answer": "Yes"}]})
    ai.outcome = {"answers": []}

    assert db_client.get(f"/api/v1/profiles/{other}/answers").json() == []
    a = by_id(prepare(db_client, other, fields=[FIELDS[9]]))
    assert a["f10"]["source"] == "none"


# --- validation and privacy ------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"job": JOB, "fields": []},
        {"job": JOB, "fields": [{"id": "x", "label": "Q", "type": "password"}]},
        {"job": {**JOB, "description": "x" * 30_001}, "fields": FIELDS[:1]},
        {"job": JOB, "fields": FIELDS[:1], "submit": True},
    ],
)
def test_invalid_requests_are_rejected(db_client: TestClient, pid: str, body: dict) -> None:
    assert db_client.post(f"/api/v1/profiles/{pid}/applications/answers", json=body).status_code == 422


def test_unknown_profile_returns_404(db_client: TestClient) -> None:
    missing = "00000000-0000-4000-8000-000000000000"
    assert prepare(db_client, missing).status_code == 404
    assert db_client.get(f"/api/v1/profiles/{missing}/answers").status_code == 404


def test_logs_contain_no_answers_or_personal_data(
    db_client: TestClient, ai: FakeProvider, pid: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    ai.outcome = AI_REPLY

    prepare(db_client, pid)

    for secret in ("arslan@example.com", "Arslan Khan", "payment APIs", "Nimbus Pay"):
        assert secret not in caplog.text
