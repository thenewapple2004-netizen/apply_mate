"""AI provider interface and the Gemini implementation.

Feature code depends only on `StructuredAIProvider` and the errors in errors.py,
so other providers can be added later and tests can substitute a fake.
"""

import logging
import random
import time
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, ValidationError

from app.modules.ai.config import GeminiSettings
from app.modules.ai.errors import (
    AIError,
    AIInvalidResponse,
    AINotConfigured,
    AIQuotaExceeded,
    AIRejected,
    AITimeout,
    AIUnavailable,
)

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


@dataclass
class StructuredResult(Generic[T]):
    data: T
    model: str


class StructuredAIProvider(Protocol):
    name: str

    def generate_structured(
        self, *, system: str, prompt: str, schema: type[T]
    ) -> StructuredResult[T]:
        """Return `schema` filled in from the model's JSON output, or raise an AIError."""
        ...


class GeminiProvider:
    """Gemini via the official google-genai SDK, with JSON output validated by Pydantic.

    Retries timeouts, server errors and unreadable responses with backoff. Quota
    errors (429) are not retried, so a spent quota fails fast with a clear message.
    """

    name = "gemini"

    def __init__(self, settings: GeminiSettings, client: object | None = None, sleep=time.sleep) -> None:
        self.settings = settings
        self._client = client
        self._sleep = sleep

    def _get_client(self):
        if self._client is None:
            if not self.settings.api_key:
                raise AINotConfigured()
            http_options = types.HttpOptions(timeout=int(self.settings.timeout_seconds * 1000))
            if self.settings.base_url:
                http_options.base_url = self.settings.base_url
            self._client = genai.Client(api_key=self.settings.api_key, http_options=http_options)
        return self._client

    def generate_structured(self, *, system: str, prompt: str, schema: type[T]) -> StructuredResult[T]:
        client = self._get_client()
        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0,
        )
        last_error: AIError = AIUnavailable()
        for attempt in range(1, self.settings.max_attempts + 1):
            started = time.monotonic()
            try:
                response = client.models.generate_content(
                    model=self.settings.model, contents=prompt, config=config
                )
                data = self._parse(response, schema)
                logger.info(
                    "Gemini call succeeded (model=%s, attempt=%d, %.1fs)",
                    self.settings.model, attempt, time.monotonic() - started,
                )
                return StructuredResult(data=data, model=self.settings.model)
            except AIError as error:
                last_error = error
            except Exception as error:  # SDK / transport errors
                last_error = self._translate(error)

            retryable = isinstance(last_error, (AIUnavailable, AIInvalidResponse))
            # Log the error class only: SDK messages can echo request content.
            logger.warning(
                "Gemini call failed (model=%s, attempt=%d/%d, %s)",
                self.settings.model, attempt, self.settings.max_attempts, type(last_error).__name__,
            )
            if not retryable or attempt == self.settings.max_attempts:
                break
            self._sleep(min(2 ** attempt, 10) + random.uniform(0, 0.5))
        raise last_error

    @staticmethod
    def _parse(response, schema: type[T]) -> T:
        text = getattr(response, "text", None)
        if not text:
            raise AIInvalidResponse("The AI returned an empty response. Please try again.")
        try:
            return schema.model_validate_json(text)
        except ValidationError:
            raise AIInvalidResponse() from None

    @staticmethod
    def _translate(error: Exception) -> AIError:
        if isinstance(error, genai_errors.APIError):
            code = getattr(error, "code", None)
            if code == 429:
                return AIQuotaExceeded()
            if code in (401, 403):
                return AIRejected(
                    "Gemini rejected the API key. Check GEMINI_API_KEY in the backend's .env file."
                )
            if code == 404:
                return AIRejected(
                    "The configured Gemini model wasn't found. Check GEMINI_MODEL in the backend's .env file."
                )
            if code == 408 or (code is not None and code >= 500):
                return AIUnavailable()
            return AIRejected()
        if isinstance(error, httpx.TimeoutException):
            return AITimeout()
        if isinstance(error, (httpx.TransportError, ConnectionError, OSError)):
            return AIUnavailable()
        return AIUnavailable()


def get_ai_provider() -> StructuredAIProvider:
    """FastAPI dependency (overridden in tests). Raises AINotConfigured on use if no key is set."""
    return GeminiProvider(GeminiSettings.from_env())
