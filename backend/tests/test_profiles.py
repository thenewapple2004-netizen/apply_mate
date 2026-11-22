import uuid

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Engine, inspect

from tests.conftest import alembic_config

BASE = "/api/v1/profiles"

ARSLAN = {
    "full_name": "Arslan Khan",
    "email": "arslan@example.com",
    "phone": "+92 300 1234567",
    "location": "Lahore, Pakistan",
    "linkedin_url": "https://www.linkedin.com/in/arslan",
}
AHMED = {"full_name": "Ahmed Raza", "email": "ahmed@example.com"}


def create(client: TestClient, body: dict) -> dict:
    response = client.post(BASE, json=body)
    assert response.status_code == 201, response.text
    return response.json()


# --- create / read --------------------------------------------------------


def test_create_returns_profile_with_id_and_timestamps(db_client: TestClient) -> None:
    profile = create(db_client, ARSLAN)

    assert uuid.UUID(profile["id"])
    assert {k: profile[k] for k in ARSLAN} == ARSLAN
    assert profile["created_at"] and profile["updated_at"]


def test_create_with_only_full_name(db_client: TestClient) -> None:
    profile = create(db_client, {"full_name": "  Sara  "})

    assert profile["full_name"] == "Sara"
    assert profile["email"] is None and profile["linkedin_url"] is None


def test_blank_optional_fields_are_stored_as_null(db_client: TestClient) -> None:
    profile = create(db_client, {"full_name": "Sara", "email": "", "phone": "   "})

    assert profile["email"] is None and profile["phone"] is None


def test_list_returns_all_profiles_in_creation_order(db_client: TestClient) -> None:
    arslan = create(db_client, ARSLAN)
    ahmed = create(db_client, AHMED)

    response = db_client.get(BASE)

    assert response.status_code == 200
    assert [p["id"] for p in response.json()] == [arslan["id"], ahmed["id"]]


def test_list_is_empty_initially(db_client: TestClient) -> None:
    assert db_client.get(BASE).json() == []


def test_get_returns_only_the_requested_profile(db_client: TestClient) -> None:
    arslan = create(db_client, ARSLAN)
    create(db_client, AHMED)

    response = db_client.get(f"{BASE}/{arslan['id']}")

    assert response.status_code == 200
    assert response.json() == arslan


# --- update ---------------------------------------------------------------


def test_patch_changes_only_sent_fields_of_one_profile(db_client: TestClient) -> None:
    arslan = create(db_client, ARSLAN)
    ahmed = create(db_client, AHMED)

    response = db_client.patch(f"{BASE}/{ahmed['id']}", json={"location": "Karachi"})

    assert response.status_code == 200
    updated = response.json()
    assert updated["location"] == "Karachi"
    assert updated["email"] == AHMED["email"]  # untouched field kept
    assert updated["updated_at"] >= ahmed["updated_at"]
    # The other profile is unchanged.
    assert db_client.get(f"{BASE}/{arslan['id']}").json() == arslan


def test_patch_can_clear_optional_field(db_client: TestClient) -> None:
    arslan = create(db_client, ARSLAN)

    response = db_client.patch(f"{BASE}/{arslan['id']}", json={"phone": None, "email": ""})

    assert response.status_code == 200
    assert response.json()["phone"] is None and response.json()["email"] is None


@pytest.mark.parametrize("full_name", [None, "", "   "])
def test_patch_cannot_clear_full_name(db_client: TestClient, full_name) -> None:
    arslan = create(db_client, ARSLAN)

    response = db_client.patch(f"{BASE}/{arslan['id']}", json={"full_name": full_name})

    assert response.status_code == 422
    assert db_client.get(f"{BASE}/{arslan['id']}").json()["full_name"] == ARSLAN["full_name"]


# --- delete ---------------------------------------------------------------


def test_delete_removes_only_that_profile(db_client: TestClient) -> None:
    arslan = create(db_client, ARSLAN)
    ahmed = create(db_client, AHMED)

    response = db_client.delete(f"{BASE}/{arslan['id']}")

    assert response.status_code == 204
    assert response.content == b""
    assert db_client.get(f"{BASE}/{arslan['id']}").status_code == 404
    assert [p["id"] for p in db_client.get(BASE).json()] == [ahmed["id"]]


# --- missing / malformed IDs ----------------------------------------------


@pytest.mark.parametrize("method", ["get", "patch", "delete"])
def test_unknown_id_returns_404(db_client: TestClient, method: str) -> None:
    kwargs = {"json": {"location": "x"}} if method == "patch" else {}

    response = getattr(db_client, method)(f"{BASE}/{uuid.uuid4()}", **kwargs)

    assert response.status_code == 404
    assert response.json() == {"detail": "Profile not found"}


def test_malformed_id_returns_422(db_client: TestClient) -> None:
    assert db_client.get(f"{BASE}/not-a-uuid").status_code == 422


# --- validation -----------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {},  # full_name missing
        {"full_name": ""},
        {"full_name": "   "},
        {"full_name": "x" * 201},
        {"full_name": "A", "location": "x" * 201},
        {"full_name": "A", "email": "not-an-email"},
        {"full_name": "A", "phone": "call me maybe"},
        {"full_name": "A", "linkedin_url": "https://evil.example.com/in/a"},
        {"full_name": "A", "linkedin_url": "javascript:alert(1)"},
        {"full_name": "A", "linkedin_url": "https://notlinkedin.com/in/a"},
        {"full_name": "A", "unexpected": "field"},
        {"full_name": 123},
    ],
)
def test_invalid_create_input_returns_422(db_client: TestClient, body: dict) -> None:
    response = db_client.post(BASE, json=body)

    assert response.status_code == 422
    assert db_client.get(BASE).json() == []  # nothing was stored


def test_linkedin_subdomains_are_accepted(db_client: TestClient) -> None:
    profile = create(db_client, {"full_name": "A", "linkedin_url": "https://pk.linkedin.com/in/a"})

    assert profile["linkedin_url"] == "https://pk.linkedin.com/in/a"


# --- migration ------------------------------------------------------------


def test_migration_is_reversible(test_database_url: str, test_engine: Engine) -> None:
    config = alembic_config(test_database_url)

    command.downgrade(config, "base")
    assert "profiles" not in inspect(test_engine).get_table_names()

    command.upgrade(config, "head")
    columns = {c["name"] for c in inspect(test_engine).get_columns("profiles")}
    assert columns == {
        "id", "full_name", "email", "phone", "location", "linkedin_url", "created_at", "updated_at",
    }
