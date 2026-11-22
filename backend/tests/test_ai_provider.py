"""GeminiProvider against a fake google-genai client: no network, no API cost."""

import logging
from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors as genai_errors

from app.modules.ai.config import GeminiSettings
from app.modules.ai.errors import (
    AIInvalidResponse,
    AINotConfigured,
    AIQuotaExceeded,
    AIRejected,
    AITimeout,
    AIUnavailable,
)
from app.modules.ai.provider import GeminiProvider
from app.modules.cv.schemas import CVExtraction

SETTINGS = GeminiSettings(
    api_key="test-key-not-real", model="gemini-test", timeout_seconds=5, max_attempts=3, base_url=None
)
GOOD_JSON = '{"summary": "Engineer", "skills": ["Python"], "technologies": [], "work_experience": [], "education": [], "projects": [], "certifications": []}'


class FakeModels:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return SimpleNamespace(text=outcome)


def provider(*outcomes, max_attempts=3):
    models = FakeModels(outcomes)
    settings = GeminiSettings(**{**SETTINGS.__dict__, "max_attempts": max_attempts})
    p = GeminiProvider(settings, client=SimpleNamespace(models=models), sleep=lambda s: None)
    return p, models


def call(p):
    return p.generate_structured(system="sys", prompt="resume text", schema=CVExtraction)


def api_error(code: int, status: str):
    return genai_errors.ClientError(code, {"error": {"code": code, "status": status, "message": "x"}}) \
        if code < 500 else genai_errors.ServerError(code, {"error": {"code": code, "status": status, "message": "x"}})


def test_success_returns_validated_model_and_requests_json() -> None:
    p, models = provider(GOOD_JSON)

    result = call(p)

    assert result.data.skills == ["Python"]
    assert result.model == "gemini-test"
    config = models.calls[0]["config"]
    assert config.response_mime_type == "application/json"
    assert config.response_schema is CVExtraction
    assert config.temperature == 0


def test_invalid_json_is_retried_then_reported() -> None:
    p, models = provider("not json", '{"skills": "should be a list"}', "")

    with pytest.raises(AIInvalidResponse):
        call(p)
    assert len(models.calls) == 3


def test_invalid_then_valid_succeeds() -> None:
    p, models = provider("{broken", GOOD_JSON)

    assert call(p).data.summary == "Engineer"
    assert len(models.calls) == 2


def test_quota_exhaustion_fails_fast_without_retry() -> None:
    p, models = provider(api_error(429, "RESOURCE_EXHAUSTED"), GOOD_JSON)

    with pytest.raises(AIQuotaExceeded) as exc:
        call(p)
    assert len(models.calls) == 1
    assert "quota" in exc.value.message.lower()


def test_server_error_is_retried() -> None:
    p, models = provider(api_error(503, "UNAVAILABLE"), api_error(500, "INTERNAL"), GOOD_JSON)

    assert call(p).data.summary == "Engineer"
    assert len(models.calls) == 3


def test_persistent_server_error_becomes_unavailable() -> None:
    p, _ = provider(*[api_error(503, "UNAVAILABLE")] * 3)

    with pytest.raises(AIUnavailable):
        call(p)


def test_timeout_is_retried_then_reported() -> None:
    p, models = provider(*[httpx.ReadTimeout("slow")] * 3)

    with pytest.raises(AITimeout):
        call(p)
    assert len(models.calls) == 3


def test_network_error_becomes_unavailable() -> None:
    p, _ = provider(httpx.ConnectError("down"), max_attempts=1)

    with pytest.raises(AIUnavailable):
        call(p)


@pytest.mark.parametrize(
    ("code", "status", "message"),
    [(400, "INVALID_ARGUMENT", "rejected"), (403, "PERMISSION_DENIED", "API key"), (404, "NOT_FOUND", "GEMINI_MODEL")],
)
def test_client_errors_are_not_retried(code: int, status: str, message: str) -> None:
    p, models = provider(api_error(code, status), GOOD_JSON)

    with pytest.raises(AIRejected) as exc:
        call(p)
    assert len(models.calls) == 1
    assert message in exc.value.message


def test_missing_api_key_is_reported_without_calling_gemini() -> None:
    p = GeminiProvider(GeminiSettings(**{**SETTINGS.__dict__, "api_key": None}))

    with pytest.raises(AINotConfigured) as exc:
        call(p)
    assert "GEMINI_API_KEY" in exc.value.message


def test_settings_repr_never_shows_the_key() -> None:
    assert "test-key-not-real" not in repr(SETTINGS)


def test_logs_contain_no_prompt_response_or_key(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    p, _ = provider("{broken", GOOD_JSON)

    p.generate_structured(system="sys", prompt="SECRET-RESUME-TEXT", schema=CVExtraction)

    assert "SECRET-RESUME-TEXT" not in caplog.text
    assert "Engineer" not in caplog.text
    assert "test-key-not-real" not in caplog.text
