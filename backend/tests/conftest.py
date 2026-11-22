"""Shared fixtures. Tests that need the database use a separate "<db>_test"
database, so running them never touches your real profiles."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_database_url
from app.db.session import get_db
from app.main import app

BACKEND_DIR = Path(__file__).resolve().parents[1]


def _test_database_url() -> str:
    url = make_url(get_database_url())
    return url.set(database=f"{url.database}_test").render_as_string(hide_password=False)


def _ensure_database_exists(url: str) -> None:
    target = make_url(url)
    admin = create_engine(target.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        exists = conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": target.database}
        )
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{target.database}"'))
    admin.dispose()


def alembic_config(url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    # ConfigParser treats % as interpolation, so escape it (URL-encoded passwords).
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


@pytest.fixture(scope="session")
def test_database_url() -> str:
    url = _test_database_url()
    _ensure_database_exists(url)
    command.upgrade(alembic_config(url), "head")
    return url


@pytest.fixture(scope="session")
def test_engine(test_database_url: str) -> Iterator[Engine]:
    engine = create_engine(test_database_url)
    yield engine
    engine.dispose()


@pytest.fixture
def db_client(test_engine: Engine) -> Iterator[TestClient]:
    """A TestClient whose requests use the test database, emptied before each test."""
    with test_engine.begin() as conn:
        conn.execute(text("TRUNCATE profiles"))

    factory = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[Session]:
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
