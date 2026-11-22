"""AI provider interface and the Gemini implementation.

Feature code depends only on `StructuredAIProvider` and the errors in errors.py,
so other providers can be added later and tests can substitute a fake.
"""

import logging
import random
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
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

    - One client (and its connection pool) is reused for every request.
    - Thinking is switched off for speed; a model that rejects that setting is
      retried without it.
    - Timeouts, server errors and unreadable responses are retried with a short
      backoff. If the main model's quota is used up (429) or it stays unavailable,
      the fallback model is tried before giving up.
    """

    name = "gemini"

    def __init__(self, settings: GeminiSettings, client: object | None = None, sleep=time.sleep) -> None:
        self.settings = settings
        self._client = client
        self._sleep = sleep
        self._lock = threading.Lock()
        self._no_thinking: set[str] = set()  # models that rejected the thinking setting

    def _get_client(self):
        with self._lock:
            if self._client is None:
                if not self.settings.api_key:
                    raise AINotConfigured()
                http_options = types.HttpOptions(timeout=int(self.settings.timeout_seconds * 1000))
                if self.settings.base_url:
                    http_options.base_url = self.settings.base_url
                self._client = genai.Client(api_key=self.settings.api_key, http_options=http_options)
            return self._client

    def _config(self, system: str, schema: type[T], model: str) -> types.GenerateContentConfig:
        kwargs = dict(
            system_instruction=system,
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0,
        )
        if self.settings.thinking_off and model not in self._no_thinking:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        return types.GenerateContentConfig(**kwargs)

    def generate_structured(self, *, system: str, prompt: str, schema: type[T]) -> StructuredResult[T]:
        client = self._get_client()
        models = [self.settings.model]
        if self.settings.fallback_model and self.settings.fallback_model != self.settings.model:
            models.append(self.settings.fallback_model)

        for index, model in enumerate(models):
            try:
                return StructuredResult(data=self._call_model(client, model, system, prompt, schema), model=model)
            except (AIQuotaExceeded, AIUnavailable) as error:
                if index + 1 == len(models):
                    raise
                logger.warning(
                    "Gemini model %s unavailable (%s); trying %s", model, type(error).__name__, models[index + 1]
                )
        raise AIUnavailable()  # unreachable: the loop returns or raises

    def _call_model(self, client, model: str, system: str, prompt: str, schema: type[T]) -> T:
        last_error: AIError = AIUnavailable()
        attempt = 0
        while attempt < self.settings.max_attempts:
            attempt += 1
            started = time.monotonic()
            try:
                response = client.models.generate_content(
                    model=model, contents=prompt, config=self._config(system, schema, model)
                )
                data = self._parse(response, schema)
                logger.info("Gemini call succeeded (model=%s, attempt=%d, %.1fs)", model, attempt, time.monotonic() - started)
                return data
            except AIError as error:
                last_error = error
            except Exception as error:  # SDK / transport errors
                if self._rejects_thinking(error, model):
                    logger.info("Model %s doesn't accept the thinking setting; retrying without it", model)
                    self._no_thinking.add(model)
                    attempt -= 1  # not a real failure: retry straight away
                    continue
                last_error = self._translate(error)

            retryable = isinstance(last_error, (AIUnavailable, AIInvalidResponse))
            # Log the error class only: SDK messages can echo request content.
            logger.warning(
                "Gemini call failed (model=%s, attempt=%d/%d, %s)",
                model, attempt, self.settings.max_attempts, type(last_error).__name__,
            )
            if not retryable or attempt >= self.settings.max_attempts:
                break
            self._sleep(0.5 * 2 ** (attempt - 1) + random.uniform(0, 0.3))
        raise last_error

    def _rejects_thinking(self, error: Exception, model: str) -> bool:
        return (
            self.settings.thinking_off
            and model not in self._no_thinking
            and isinstance(error, genai_errors.APIError)
            and getattr(error, "code", None) == 400
            and "thinking" in str(error).lower()
        )

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


@lru_cache
def get_ai_provider() -> StructuredAIProvider:
    """FastAPI dependency (overridden in tests). One provider, and so one HTTP
    connection pool, is shared by all requests. Raises AINotConfigured on use if no key is set."""
    return GeminiProvider(GeminiSettings.from_env())
