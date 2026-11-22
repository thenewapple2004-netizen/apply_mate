"""Database connectivity tests. They need the db service, so run them in Docker:

    docker compose run --rm backend pytest
"""

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api import health
from app.core.config import get_database_url
from app.db.session import get_engine
from app.main import app

client = TestClient(app)


def test_engine_executes_select_one() -> None:
    with get_engine().connect() as connection:
        assert connection.execute(text("SELECT 1")).scalar_one() == 1


def test_health_db_reports_ok() -> None:
    response = client.get("/health/db")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_health_db_failure_is_safe(monkeypatch) -> None:
    def broken_engine():
        raise RuntimeError(f"cannot connect to {get_database_url()}")

    monkeypatch.setattr(health, "get_engine", broken_engine)

    response = client.get("/health/db")

    assert response.status_code == 503
    assert response.json() == {"status": "error", "database": "unavailable"}
    # The connection string (and so the password) must never leak into the response.
    assert get_database_url() not in response.text
    assert "@db" not in response.text
