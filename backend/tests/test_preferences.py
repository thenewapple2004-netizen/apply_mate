"""Applicant preferences: storage, answers taken from them, approval rules and invalidation."""

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from tests.test_cv import FakeProvider, ai  # noqa: F401  (fixture)

JOB = {"title": "Backend Engineer", "company": "Nimbus Pay", "description": "Python APIs.", "url": ""}

FULL = {
    "salary_expectation": "PKR 400,000 per month",
    "notice_period": "30 days",
    "preferred_locations": ["Lahore", "Remote"],
    "work_arrangements": ["hybrid"],
    "work_authorization_countries": ["Pakistan"],
    "requires_sponsorship": False,
    "change_reason": "I want to work on larger payment systems.",
    "career_goals": "Grow into a staff engineer leading payments infrastructure.",
}


@pytest.fixture
def pid(db_client: TestClient) -> str:
    return db_client.post("/api/v1/profiles", json={"full_name": "Arslan Khan", "email": "a@example.com"}).json()["id"]


def prefs_url(pid: str) -> str:
    return f"/api/v1/profiles/{pid}/preferences"


def options(*labels: str) -> list[dict]:
    return [{"value": label, "label": label} for label in labels]


def field(id_: str, label: str, type_: str = "text", opts: list[dict] | None = None) -> dict:
    return {"id": id_, "label": label, "type": type_, "options": opts or []}


def prepare(client: TestClient, pid: str, *fields: dict, job: dict = JOB):
    return client.post(f"/api/v1/profiles/{pid}/applications/answers", json={"job": job, "fields": list(fields)})


def by_id(response) -> dict:
    return {a["field_id"]: a for a in response.json()["answers"]}


# --- storage -------------------------------------------------------------------------------


def test_preferences_start_empty_and_every_field_is_optional(db_client: TestClient, pid: str) -> None:
    body = db_client.get(prefs_url(pid)).json()

    assert body == {
        "salary_expectation": None, "notice_period": None, "preferred_locations": [], "work_arrangements": [],
        "work_authorization_countries": [], "requires_sponsorship": None, "change_reason": None, "career_goals": None, "updated_at": None,
    }
    assert db_client.put(prefs_url(pid), json={}).status_code == 200


def test_preferences_are_saved_and_edited(db_client: TestClient, pid: str) -> None:
    saved = db_client.put(prefs_url(pid), json=FULL).json()

    assert saved["salary_expectation"] == "PKR 400,000 per month" and saved["updated_at"]
    assert db_client.get(prefs_url(pid)).json() == saved

    edited = db_client.put(prefs_url(pid), json={**FULL, "notice_period": "60 days", "requires_sponsorship": True}).json()
    assert edited["notice_period"] == "60 days" and edited["requires_sponsorship"] is True


def test_put_replaces_everything_and_blank_means_not_set(db_client: TestClient, pid: str) -> None:
    db_client.put(prefs_url(pid), json=FULL)

    cleared = db_client.put(prefs_url(pid), json={"notice_period": "  ", "preferred_locations": [" ", None]}).json()

    assert cleared["salary_expectation"] is None and cleared["notice_period"] is None
    assert cleared["preferred_locations"] == [] and cleared["requires_sponsorship"] is None


def test_lists_are_cleaned(db_client: TestClient, pid: str) -> None:
    saved = db_client.put(prefs_url(pid), json={
        "preferred_locations": [" Lahore ", "lahore", "Karachi", ""], "work_arrangements": ["remote", "remote", "hybrid"],
    }).json()

    assert saved["preferred_locations"] == ["Lahore", "Karachi"] and saved["work_arrangements"] == ["remote", "hybrid"]


@pytest.mark.parametrize(
    "body",
    [
        {"work_arrangements": ["office"]},
        {"salary_expectation": "x" * 201},
        {"notice_period": "x" * 101},
        {"change_reason": "x" * 2001},
        {"career_goals": "x" * 2001},
        {"preferred_locations": ["x" * 101]},
        {"requires_sponsorship": "maybe"},
        {"unknown_field": 1},
    ],
)
def test_invalid_preferences_are_rejected(db_client: TestClient, pid: str, body: dict) -> None:
    assert db_client.put(prefs_url(pid), json=body).status_code == 422
    assert db_client.get(prefs_url(pid)).json()["updated_at"] is None


def test_preferences_are_per_profile_and_removed_with_it(db_client: TestClient, pid: str) -> None:
    other = db_client.post("/api/v1/profiles", json={"full_name": "Ahmed"}).json()["id"]
    db_client.put(prefs_url(pid), json=FULL)

    assert db_client.get(prefs_url(other)).json()["salary_expectation"] is None
    assert db_client.delete(f"/api/v1/profiles/{pid}").status_code == 204
    assert db_client.get(prefs_url(pid)).status_code == 404


def test_unknown_profile_returns_404(db_client: TestClient) -> None:
    missing = str(uuid.uuid4())
    assert db_client.get(prefs_url(missing)).status_code == 404
    assert db_client.put(prefs_url(missing), json={}).status_code == 404


# --- answers from preferences -------------------------------------------------------------------


def test_salary_comes_from_preferences_but_needs_approval(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json=FULL)

    a = by_id(prepare(db_client, pid, field("s", "What are your salary expectations?")))["s"]

    assert a["value"] == "PKR 400,000 per month" and a["source"] == "preference"
    assert a["needs_approval"] is True and a["preference"] == "salary"
    assert ai.prompts == []  # never sent to the AI


def test_missing_preference_asks_the_user_instead_of_inventing(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    fields = [
        field("s", "Expected salary"),
        field("a", "Are you legally authorized to work in Pakistan?", "radio", options("Yes", "No")),
        field("v", "Will you require visa sponsorship?", "radio", options("Yes", "No")),
    ]

    answers = by_id(prepare(db_client, pid, *fields))

    for key, kind in (("s", "salary"), ("a", "authorization"), ("v", "sponsorship")):
        assert answers[key]["value"] is None and answers[key]["source"] == "none"
        assert "Preferences" in answers[key]["note"] and answers[key]["preference"] == kind
        assert answers[key]["needs_approval"] is False
    assert ai.prompts == []  # sensitive: not even offered to the AI


def test_notice_period_text_and_select(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json=FULL)
    ai.outcome = {"answers": []}

    a = by_id(prepare(
        db_client, pid,
        field("t", "What is your notice period?"),
        field("o", "Notice period", "select", options("Immediately", "30 days", "60 days")),
        field("n", "Notice period", "select", options("Immediately", "1 month")),
    ))

    assert a["t"]["value"] == "30 days" and a["t"]["source"] == "preference" and a["t"]["needs_approval"] is False
    assert a["o"]["value"] == "30 days"
    assert a["n"]["value"] is None and "30 days" in a["n"]["note"]  # no matching option: asks, doesn't guess
    assert ai.prompts == []


def test_missing_notice_period_still_offers_ai_suggestions_but_never_answers(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": [{"field_id": "n", "value": "2 weeks", "suggestions": [{"choice": "2 weeks"}, {"choice": "1 month"}]}]}

    a = by_id(prepare(db_client, pid, field("n", "What is your notice period?")))["n"]

    assert a["source"] == "ai"  # the AI answered a non-sensitive question; the note below applies only when blank
    ai.outcome = {"answers": [{"field_id": "m", "value": None, "suggestions": [{"choice": "2 weeks"}, {"choice": "1 month"}]}]}
    b = by_id(prepare(db_client, pid, field("m", "Notice period")))["m"]
    assert b["value"] is None and "Preferences" in b["note"] and [s["label"] for s in b["suggestions"]] == ["2 weeks", "1 month"]


def test_work_arrangement(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json={"work_arrangements": ["hybrid"]})
    ai.outcome = {"answers": []}

    a = by_id(prepare(
        db_client, pid,
        field("r", "Which work arrangement do you prefer?", "radio", options("On-site", "Hybrid", "Remote")),
        field("t", "Preferred work arrangement"),
        field("y", "Are you open to hybrid work?", "radio", options("Yes", "No")),
        field("n", "Are you open to remote work?", "radio", options("Yes", "No")),
    ))

    assert a["r"]["value"] == "Hybrid" and a["t"]["value"] == "Hybrid"
    assert a["y"]["value"] == "Yes"
    assert a["n"]["value"] is None  # never answers "No" for them


def test_several_arrangements_are_left_for_the_user_to_choose(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json={"work_arrangements": ["remote", "hybrid"]})
    ai.outcome = {"answers": []}

    a = by_id(prepare(
        db_client, pid,
        field("r", "Preferred work arrangement", "radio", options("On-site", "Hybrid", "Remote")),
        field("c", "Preferred work arrangement", "checkbox", options("On-site", "Hybrid", "Remote")),
        field("t", "Work arrangement preference"),
    ))

    assert a["r"]["value"] is None and "choose one" in a["r"]["note"].lower()
    assert sorted(a["c"]["values"]) == ["Hybrid", "Remote"]
    assert a["t"]["value"] == "Remote or Hybrid"


def test_preferred_locations(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json={"preferred_locations": ["Lahore", "Karachi"]})
    ai.outcome = {"answers": []}

    a = by_id(prepare(
        db_client, pid,
        field("t", "Preferred work locations"),
        field("s", "Preferred location", "select", options("Islamabad", "Lahore, Pakistan")),
    ))

    assert a["t"]["value"] == "Lahore, Karachi" and a["s"]["value"] == "Lahore, Pakistan"


def test_reason_for_changing_jobs(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json=FULL)
    ai.outcome = {"answers": []}

    a = by_id(prepare(db_client, pid, field("r", "What is your reason for leaving your current job?", "textarea")))["r"]

    assert a["value"] == FULL["change_reason"] and a["source"] == "preference" and a["needs_approval"] is False


def test_career_goals_are_answered_from_preferences_or_asked(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": []}
    question = field("g", "Where do you see yourself in five years?", "textarea")
    assert "Preferences" in by_id(prepare(db_client, pid, question))["g"]["note"]

    db_client.put(prefs_url(pid), json=FULL)
    a = by_id(prepare(db_client, pid, question))["g"]

    assert a["value"] == FULL["career_goals"] and a["source"] == "preference" and a["needs_approval"] is False


def test_work_authorization_needs_approval_and_is_never_guessed(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json=FULL)
    yes_no = options("Yes", "No")

    a = by_id(prepare(
        db_client, pid,
        field("pk", "Are you legally authorized to work in Pakistan?", "radio", yes_no),
        field("us", "Are you authorized to work in the United States?", "radio", yes_no),
        field("both", "Are you authorized to work in Pakistan without visa sponsorship?", "radio", yes_no),
    ))

    assert a["pk"]["value"] == "Yes" and a["pk"]["needs_approval"] is True and a["pk"]["source"] == "preference"
    assert a["us"]["value"] is None and "somewhere else" in a["us"]["note"]  # not "No"
    assert a["both"]["value"] is None and "yourself" in a["both"]["note"]
    assert ai.prompts == []


def test_sponsorship_answers_and_inverted_questions(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    yes_no = options("Yes", "No")
    db_client.put(prefs_url(pid), json={"requires_sponsorship": False})

    a = by_id(prepare(
        db_client, pid,
        field("a", "Will you now or in the future require visa sponsorship?", "radio", yes_no),
        field("b", "Can you work without visa sponsorship?", "radio", yes_no),
    ))
    assert a["a"]["value"] == "No" and a["a"]["needs_approval"] is True
    assert a["b"]["value"] == "Yes" and a["b"]["needs_approval"] is True

    db_client.put(prefs_url(pid), json={"requires_sponsorship": True})
    b = by_id(prepare(db_client, pid, field("a", "Do you require sponsorship?", "radio", yes_no)))
    assert b["a"]["value"] == "Yes"


def test_consent_and_demographic_questions_are_still_never_answered(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json=FULL)

    a = by_id(prepare(
        db_client, pid,
        field("c", "I certify that my answers are true and agree to the privacy policy", "checkbox", options("I agree")),
        field("g", "Gender", "select", options("Male", "Female")),
        field("n", "Citizenship"),
    ))

    assert all(a[k]["source"] == "none" and not a[k]["value"] for k in "cgn")
    assert ai.prompts == []


def test_only_non_sensitive_preferences_reach_the_ai(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    db_client.put(prefs_url(pid), json=FULL)
    ai.outcome = {"answers": []}

    prepare(db_client, pid, field("m", "Why do you want to join Nimbus Pay?", "textarea"))

    prompt = ai.prompts[0]
    assert "30 days" in prompt and "larger payment systems" in prompt and "hybrid" in prompt and "staff engineer" in prompt
    assert "400,000" not in prompt and "Pakistan" not in prompt and "sponsorship" not in prompt


def test_sensitive_answers_are_never_saved_or_cached(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    saved = db_client.put(f"/api/v1/profiles/{pid}/answers", json={"answers": [
        {"question": "Are you legally authorized to work in Pakistan?", "answer": "Yes"},
        {"question": "Will you require visa sponsorship?", "answer": "No"},
        {"question": "What are your salary expectations?", "answer": "100k"},
        {"question": "Preferred work location", "answer": "Lahore"},
    ]})

    assert saved.json() == {"saved": 1}


# --- changing preferences invalidates outdated answers ----------------------------------------------


def test_changing_preferences_invalidates_cached_ai_answers(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": [{"field_id": "m", "value": "Because of the work."}]}
    question = field("m", "Why do you want this job?", "textarea")
    prepare(db_client, pid, question)
    assert prepare(db_client, pid, question).json()["cache_hits"] == 1 and len(ai.prompts) == 1

    db_client.put(prefs_url(pid), json={"notice_period": "30 days"})

    after = prepare(db_client, pid, question).json()
    assert after["cache_hits"] == 0 and len(ai.prompts) == 2  # asked the AI again
    assert prepare(db_client, pid, question).json()["cache_hits"] == 1  # and cached under the new version


def test_context_version_changes_with_preferences_only_when_edited(db_client: TestClient, pid: str) -> None:
    def version() -> str:
        return db_client.get(f"/api/v1/profiles/{pid}/applications/context").json()["version"]

    before = version()
    assert version() == before

    db_client.put(prefs_url(pid), json={"notice_period": "30 days"})
    first = version()
    assert first != before and version() == first

    db_client.put(prefs_url(pid), json={"notice_period": "60 days"})
    assert version() != first


def test_prepared_answers_report_the_version_they_were_based_on(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": []}
    stamp = prepare(db_client, pid, field("s", "Salary")).json()["context_version"]
    assert stamp == db_client.get(f"/api/v1/profiles/{pid}/applications/context").json()["version"]

    db_client.put(prefs_url(pid), json={"salary_expectation": "100k"})

    assert db_client.get(f"/api/v1/profiles/{pid}/applications/context").json()["version"] != stamp


def test_context_version_unknown_profile(db_client: TestClient) -> None:
    assert db_client.get(f"/api/v1/profiles/{uuid.uuid4()}/applications/context").status_code == 404


def test_logs_never_contain_preference_values(db_client: TestClient, ai: FakeProvider, pid: str, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    caplog.set_level(logging.DEBUG)
    db_client.put(prefs_url(pid), json=FULL)
    prepare(db_client, pid, field("s", "What are your salary expectations?"))

    for secret in ("400,000", "larger payment systems", "30 days"):
        assert secret not in caplog.text
