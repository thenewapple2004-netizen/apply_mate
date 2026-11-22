"""Applied-jobs history: recording, counting without duplicates, time-zone aware stats."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.modules.applications.history import job_key

JOB = {"title": "Backend Engineer (Python)", "company": "Nimbus Pay", "url": "https://jobs.example.com/nimbus/123"}


@pytest.fixture
def pid(db_client: TestClient) -> str:
    return db_client.post("/api/v1/profiles", json={"full_name": "Arslan"}).json()["id"]


def base(pid: str) -> str:
    return f"/api/v1/profiles/{pid}/applications"


def record(client: TestClient, pid: str, **body):
    return client.post(base(pid), json={**JOB, **body})


def stats(client: TestClient, pid: str, tz: str = "UTC") -> dict:
    return client.get(f"{base(pid)}/stats", params={"tz": tz}).json()


def ago(**delta) -> str:
    return (datetime.now(UTC) - timedelta(**delta)).isoformat()


# --- recording --------------------------------------------------------------------------


def test_marking_a_job_as_applied_records_it(db_client: TestClient, pid: str) -> None:
    response = record(db_client, pid)

    assert response.status_code == 201
    body = response.json()
    assert body["title"] == JOB["title"] and body["company"] == "Nimbus Pay" and body["already_recorded"] is False
    assert datetime.fromisoformat(body["applied_at"]) <= datetime.now(UTC)
    assert db_client.get(base(pid)).json()[0]["id"] == body["id"]


def test_the_same_job_is_counted_once(db_client: TestClient, pid: str) -> None:
    first = record(db_client, pid).json()

    again = record(db_client, pid)

    assert again.status_code == 200 and again.json()["id"] == first["id"] and again.json()["already_recorded"] is True
    assert stats(db_client, pid)["total"] == 1


@pytest.mark.parametrize(
    "url",
    [
        "https://jobs.example.com/nimbus/123/",                         # trailing slash
        "https://JOBS.example.com/Nimbus/123?utm_source=x&gh_src=y",    # tracking parameters, case
        "https://jobs.example.com/nimbus/123/apply",                    # the application form of the same job
    ],
)
def test_links_to_the_same_job_match(db_client: TestClient, pid: str, url: str) -> None:
    record(db_client, pid)

    assert record(db_client, pid, url=url).json()["already_recorded"] is True


def test_different_jobs_on_the_same_site_are_separate(db_client: TestClient, pid: str) -> None:
    record(db_client, pid, url="https://careers.example.com/jobs?gh_jid=111")
    record(db_client, pid, url="https://careers.example.com/jobs?gh_jid=222&utm_medium=email")

    assert stats(db_client, pid)["total"] == 2


def test_jobs_without_a_link_are_matched_by_title_and_company(db_client: TestClient, pid: str) -> None:
    record(db_client, pid, url="")

    assert record(db_client, pid, url="", title="  backend  engineer (python) ", company="NIMBUS PAY").json()["already_recorded"] is True
    assert record(db_client, pid, url="", company="Other Co").json()["already_recorded"] is False


def test_job_key_is_stable() -> None:
    assert job_key("a", "b", "https://x.com/j/1?utm_a=1") == job_key("c", "d", "https://x.com/j/1")


@pytest.mark.parametrize(
    "body",
    [
        {},                                                   # nothing identifies the job
        {"title": "  ", "url": ""},
        {"title": "x" * 301},
        {"title": "A", "unexpected": True},
        {"title": "A", "applied_at": "2026-01-01T10:00:00"},  # no time zone
        {"title": "A", "applied_at": (datetime.now(UTC) + timedelta(days=2)).isoformat()},
    ],
)
def test_invalid_applications_are_rejected(db_client: TestClient, pid: str, body: dict) -> None:
    assert db_client.post(base(pid), json=body).status_code == 422
    assert stats(db_client, pid)["total"] == 0


# --- history and removal -----------------------------------------------------------------


def test_history_lists_newest_first_with_a_limit(db_client: TestClient, pid: str) -> None:
    for i, when in enumerate([ago(days=3), ago(days=1), ago(days=2)]):
        record(db_client, pid, title=f"Job {i}", url=f"https://x.com/{i}", applied_at=when)

    titles = [a["title"] for a in db_client.get(base(pid)).json()]
    limited = db_client.get(base(pid), params={"limit": 2}).json()

    assert titles == ["Job 1", "Job 2", "Job 0"]
    assert [a["title"] for a in limited] == ["Job 1", "Job 2"]
    assert db_client.get(base(pid), params={"limit": 0}).status_code == 422


def test_an_entry_can_be_removed_and_the_job_recorded_again(db_client: TestClient, pid: str) -> None:
    created = record(db_client, pid).json()

    assert db_client.delete(f"{base(pid)}/{created['id']}").status_code == 204
    assert stats(db_client, pid)["total"] == 0
    assert db_client.delete(f"{base(pid)}/{created['id']}").status_code == 404
    assert record(db_client, pid).status_code == 201


# --- statistics ----------------------------------------------------------------------------


def test_stats_count_today_week_and_month(db_client: TestClient, pid: str) -> None:
    for i, when in enumerate([ago(minutes=1), ago(days=2), ago(days=10), ago(days=40)]):
        record(db_client, pid, url=f"https://x.com/{i}", applied_at=when)

    s = stats(db_client, pid)

    assert s["total"] == 4 and s["last_30_days"] == 3 and s["last_7_days"] <= 2 and s["today"] <= 1
    assert s["last_7_days"] >= 1 and s["timezone"] == "UTC"


def test_today_follows_the_applicants_time_zone(db_client: TestClient, pid: str) -> None:
    # Applied 30 minutes ago. In a zone where that was just after midnight it's "today";
    # in a zone 14h apart it's the previous calendar day only if that zone's midnight was later.
    record(db_client, pid, applied_at=ago(minutes=30))
    now = datetime.now(UTC)

    for tz in ("Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Karachi", "America/New_York"):
        from zoneinfo import ZoneInfo

        local = now.astimezone(ZoneInfo(tz))
        local_then = (now - timedelta(minutes=30)).astimezone(ZoneInfo(tz))
        expected_today = 1 if local_then.date() == local.date() else 0
        assert stats(db_client, pid, tz)["today"] == expected_today, tz


def test_invalid_time_zone_is_rejected(db_client: TestClient, pid: str) -> None:
    assert db_client.get(f"{base(pid)}/stats", params={"tz": "Mars/Olympus"}).status_code == 422


# --- isolation ---------------------------------------------------------------------------------


def test_history_is_separate_per_profile(db_client: TestClient, pid: str) -> None:
    other = db_client.post("/api/v1/profiles", json={"full_name": "Ahmed"}).json()["id"]
    mine = record(db_client, pid).json()

    # The same job can be applied to by both applicants, and neither sees the other's history.
    assert record(db_client, other).status_code == 201
    assert stats(db_client, pid)["total"] == 1 and stats(db_client, other)["total"] == 1
    assert db_client.delete(f"{base(other)}/{mine['id']}").status_code == 404
    assert stats(db_client, pid)["total"] == 1


def test_deleting_a_profile_removes_its_history(db_client: TestClient, pid: str) -> None:
    record(db_client, pid)

    assert db_client.delete(f"/api/v1/profiles/{pid}").status_code == 204
    assert db_client.get(base(pid)).status_code == 404


def test_unknown_profile_returns_404(db_client: TestClient) -> None:
    missing = str(uuid.uuid4())

    assert record(db_client, missing).status_code == 404
    assert db_client.get(base(missing)).status_code == 404
    assert db_client.get(f"{base(missing)}/stats").status_code == 404
