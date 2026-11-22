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
    # Contact fields come from the profile and the consent box is the user's: neither goes to the AI.
    assert [f["id"] for f in fields] == ["f6", "f7", "f8", "f9", "f10", "f11"]
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


# --- sensitive questions and missing information ----------------------------------------

SENSITIVE_FIELDS = [
    {"id": "g", "label": "Gender", "type": "select", "options": [{"value": "Male", "label": "Male"}, {"value": "Female", "label": "Female"}]},
    {"id": "v", "label": "Veteran Status", "type": "select", "options": [{"value": "No", "label": "I am not a protected veteran"}]},
    {"id": "s", "label": "What are your salary expectations?", "type": "text"},
    {"id": "p", "label": "I agree to the privacy policy", "type": "checkbox", "options": [{"value": "on", "label": "I agree"}]},
]


def test_sensitive_questions_are_left_to_the_user(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": [{"field_id": "g", "value": "Male"}, {"field_id": "s", "value": "100k"}]}

    response = prepare(db_client, pid, fields=SENSITIVE_FIELDS)

    a = by_id(response)
    assert all(a[k]["source"] == "none" and a[k]["value"] is None for k in "gvsp")
    assert "yourself" in a["g"]["note"] and "tick it yourself" in a["p"]["note"]
    assert ai.prompts == []  # nothing sensitive was sent to the AI


def test_missing_contact_details_say_what_to_add(db_client: TestClient, ai: FakeProvider) -> None:
    pid = db_client.post("/api/v1/profiles", json={"full_name": "Sara"}).json()["id"]
    fields = [
        {"id": "e", "label": "Email", "type": "email"},
        {"id": "l", "label": "Last name", "type": "text"},
        {"id": "i", "label": "LinkedIn Profile", "type": "url"},
    ]

    a = by_id(prepare(db_client, pid, fields=fields))

    assert "Add it with Edit details" in a["e"]["note"] and "LinkedIn" in a["i"]["note"]
    assert "last name" in a["l"]["note"]
    assert ai.prompts == []


def test_custom_dropdown_options_match_by_label(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    """Greenhouse-style dropdowns send option labels as values."""
    field = {"id": "c", "label": "Have you previously worked at GitLab?", "type": "select",
             "options": [{"value": "Yes", "label": "Yes"}, {"value": "No", "label": "No"}]}
    ai.outcome = {"answers": [{"field_id": "c", "value": "no"}]}

    a = by_id(prepare(db_client, pid, fields=[field]))

    assert a["c"]["value"] == "No" and a["c"]["source"] == "ai"


def test_sensitive_and_consent_answers_are_never_saved(db_client: TestClient, pid: str) -> None:
    result = db_client.put(f"/api/v1/profiles/{pid}/answers", json={"answers": [
        {"question": "Gender", "answer": "Male"},
        {"question": "I agree to the privacy policy", "answer": "on"},
        {"question": "What are your salary expectations?", "answer": "100k"},
        {"question": "Which work arrangement do you prefer?", "answer": "Remote"},
    ]})

    assert result.json() == {"saved": 1}
    assert db_client.get(f"/api/v1/profiles/{pid}/answers").json() == [
        {"question": "Which work arrangement do you prefer?", "answer": "Remote"}
    ]


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


# --- suggestions for "Needs you" questions, and answers written from a choice ------------

NOTICE = {"id": "n", "label": "What is your current notice period?", "type": "text"}
TIMING = {"id": "t", "label": "Are you comfortable working from 11 AM to 2 PM PKT?", "type": "textarea"}


def compose(client: TestClient, pid: str, question: str, choice: str, type_: str = "textarea"):
    return client.post(f"/api/v1/profiles/{pid}/applications/answers/compose",
                       json={"job": JOB, "question": question, "type": type_, "choice": choice})


def test_unanswered_text_questions_get_suggestions(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    s = lambda choice, answer=None: {"choice": choice, "answer": answer}  # noqa: E731
    ai.outcome = {"answers": [
        {"field_id": "n", "value": None, "suggestions": [
            s("Immediately", "I can start immediately."), s("2 weeks"), s("2 weeks"), s(" 1 month "), None,
            s("2 months"), s("3 months")]},
        {"field_id": "t", "value": None, "suggestions": [
            s("Yes", "Yes, I'm comfortable with 11 AM to 2 PM PKT."),
            s("No", "Yes, that works for me."),  # contradicts the choice: dropped
        ]},
        {"field_id": "f6", "value": "5", "suggestions": [s("4"), s("6")]},  # answered: no suggestions
    ]}

    a = by_id(prepare(db_client, pid, fields=[NOTICE, TIMING, FIELDS[5]]))

    assert a["n"]["value"] is None
    assert [x["label"] for x in a["n"]["suggestions"]] == ["Immediately", "2 weeks", "1 month", "2 months"]
    assert a["n"]["suggestions"][0]["answer"] == "I can start immediately."
    assert a["t"]["suggestions"] == [
        {"label": "Yes", "answer": "Yes, I'm comfortable with 11 AM to 2 PM PKT."},
        {"label": "No", "answer": None},  # the extension words it on click instead
    ]
    assert a["f6"]["value"] == "5" and a["f6"]["suggestions"] == []


def test_choice_fields_and_sensitive_questions_get_no_ai_suggestions(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": [{"field_id": "f9", "value": None, "suggestions": [{"choice": "Remote"}]}]}

    a = by_id(prepare(db_client, pid, fields=[FIELDS[8], SENSITIVE_FIELDS[2]]))

    assert a["f9"]["suggestions"] == []  # its own options are the choices
    assert a["s"]["suggestions"] == []   # salary: the user's to answer


def test_compose_writes_an_answer_from_the_choice(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"value": "Yes, I can work from 11 AM to 2 PM PKT and am comfortable with that overlap."}

    response = compose(db_client, pid, TIMING["label"], "Yes")

    assert response.status_code == 200
    assert response.json() == {"value": ai.outcome["value"], "composed": True}
    prompt = ai.prompts[0]
    assert '"choice":"Yes"' in prompt and "11 AM to 2 PM" in prompt and "Nimbus Pay" in prompt


def test_compose_never_contradicts_a_yes_no_choice(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"value": "Yes, that works for me."}

    response = compose(db_client, pid, TIMING["label"], "No")

    assert response.json() == {"value": "No", "composed": False}


def test_compose_uses_sensitive_or_simple_choices_as_is(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"value": "should not be used"}

    salary = compose(db_client, pid, "What are your salary expectations?", "Negotiable", "text")
    number = compose(db_client, pid, "Years of experience", "5", "number")

    assert salary.json() == {"value": "Negotiable", "composed": False}
    assert number.json() == {"value": "5", "composed": False}
    assert ai.prompts == []


def test_compose_reports_ai_failures(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = AIQuotaExceeded()

    response = compose(db_client, pid, NOTICE["label"], "2 weeks", "text")

    assert response.status_code == 429 and "quota" in response.json()["detail"]


# --- answer cache: repeated questions skip the AI ------------------------------------------

CACHEABLE = [FIELDS[5], FIELDS[6], FIELDS[10]]  # years (number), education (select), cover letter (textarea)
CACHE_REPLY = {"answers": [
    {"field_id": "f6", "value": "5"},
    {"field_id": "f7", "value": "bachelors"},
    {"field_id": "f11", "value": "I build payment APIs in Python."},
]}
OTHER_JOB = {**JOB, "title": "Data Engineer", "company": "OtherCo", "description": "Spark pipelines."}


def test_repeated_questions_are_answered_from_the_cache(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = CACHE_REPLY
    first = prepare(db_client, pid, fields=CACHEABLE).json()
    assert first["cache_hits"] == 0 and len(ai.prompts) == 1

    second = prepare(db_client, pid, fields=CACHEABLE).json()

    assert len(ai.prompts) == 1  # no second AI call
    assert second["cache_hits"] == 3 and second["ai_used"] is False
    assert [a["value"] for a in second["answers"]] == [a["value"] for a in first["answers"]]
    assert all(a["cached"] and a["source"] == "ai" for a in second["answers"])


def test_cache_matches_the_same_question_on_a_different_form(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = CACHE_REPLY
    prepare(db_client, pid, fields=CACHEABLE)
    # Another site: other field ids and slightly different wording/markers, same question and options.
    reworded = [{**FIELDS[6], "id": "zz", "label": "Highest level of education *"}]

    result = prepare(db_client, pid, fields=reworded).json()

    assert result["cache_hits"] == 1 and len(ai.prompts) == 1
    assert result["answers"][0]["field_id"] == "zz" and result["answers"][0]["value"] == "bachelors"


def test_job_specific_answers_are_cached_per_job(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = CACHE_REPLY
    prepare(db_client, pid, fields=CACHEABLE)

    other = prepare(db_client, pid, fields=CACHEABLE, job=OTHER_JOB).json()

    # Years and education don't depend on the job; the cover letter does.
    assert other["cache_hits"] == 2
    assert len(ai.prompts) == 2
    assert [json.loads(p.split("<fields>\n")[1].split("\n</fields>")[0])[0]["id"] for p in ai.prompts[1:]] == ["f11"]
    assert "OtherCo" in ai.prompts[1]


def test_cache_is_dropped_when_the_profile_or_cv_changes(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = CACHE_REPLY
    prepare(db_client, pid, fields=CACHEABLE)
    db_client.put(f"/api/v1/profiles/{pid}/cv", json={"technologies": ["Python", "Rust"]})

    after_cv = prepare(db_client, pid, fields=CACHEABLE).json()
    assert after_cv["cache_hits"] == 0 and len(ai.prompts) == 2

    db_client.patch(f"/api/v1/profiles/{pid}", json={"location": "Karachi"})
    after_profile = prepare(db_client, pid, fields=CACHEABLE).json()
    assert after_profile["cache_hits"] == 0 and len(ai.prompts) == 3


def test_refresh_asks_the_ai_again(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = CACHE_REPLY
    prepare(db_client, pid, fields=CACHEABLE)
    ai.outcome = {"answers": [{"field_id": "f6", "value": "6"}, {"field_id": "f7", "value": "masters"}, {"field_id": "f11", "value": "New text."}]}

    refreshed = db_client.post(f"/api/v1/profiles/{pid}/applications/answers",
                               json={"job": JOB, "fields": CACHEABLE, "refresh": True}).json()
    again = prepare(db_client, pid, fields=CACHEABLE).json()

    assert refreshed["cache_hits"] == 0 and len(ai.prompts) == 2
    assert [a["value"] for a in refreshed["answers"]] == ["6", "masters", "New text."]
    assert [a["value"] for a in again["answers"]] == ["6", "masters", "New text."]  # the new answers are what's remembered


def test_needs_you_results_and_their_suggestions_are_cached(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": [{"field_id": "n", "value": None, "suggestions": [{"choice": "2 weeks"}, {"choice": "1 month"}]}]}
    prepare(db_client, pid, fields=[NOTICE])

    again = by_id(prepare(db_client, pid, fields=[NOTICE]))

    assert len(ai.prompts) == 1
    assert [s["label"] for s in again["n"]["suggestions"]] == ["2 weeks", "1 month"]


def test_ai_failures_are_never_cached(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = AIQuotaExceeded()
    assert prepare(db_client, pid, fields=CACHEABLE).json()["ai_error"]

    ai.outcome = CACHE_REPLY
    recovered = prepare(db_client, pid, fields=CACHEABLE).json()

    assert recovered["ai_used"] is True and recovered["cache_hits"] == 0
    assert [a["value"] for a in recovered["answers"]] == ["5", "bachelors", "I build payment APIs in Python."]


def test_cache_is_per_profile(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    other = db_client.post("/api/v1/profiles", json={"full_name": "Ahmed"}).json()["id"]
    ai.outcome = CACHE_REPLY
    prepare(db_client, pid, fields=CACHEABLE)

    result = prepare(db_client, other, fields=CACHEABLE).json()

    assert result["cache_hits"] == 0 and len(ai.prompts) == 2


def test_saved_answers_beat_the_cache(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = CACHE_REPLY
    prepare(db_client, pid, fields=CACHEABLE)
    db_client.put(f"/api/v1/profiles/{pid}/answers", json={"answers": [
        {"question": "Highest level of education", "answer": "Master's degree"}]})

    a = by_id(prepare(db_client, pid, fields=CACHEABLE))

    assert a["f7"]["value"] == "masters" and a["f7"]["source"] == "saved" and not a["f7"]["cached"]


def test_prompts_are_compact(db_client: TestClient, ai: FakeProvider, pid: str) -> None:
    ai.outcome = {"answers": []}
    prepare(db_client, pid, fields=[FIELDS[6]], job={**JOB, "description": "x" * 20_000})

    prompt = ai.prompts[0]

    assert '"options":["High school"' not in prompt            # {value,label} pairs differ here, so objects stay
    assert '": ' not in prompt.split("<fields>")[1]            # no spaces in the JSON
    assert "null" not in prompt.split("<applicant>")[1].split("</applicant>")[0]  # empty values dropped
    assert len(prompt) < 9_000                                 # job description capped
