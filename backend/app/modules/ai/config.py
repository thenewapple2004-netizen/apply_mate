import os
from dataclasses import dataclass

DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"


@dataclass(frozen=True)
class GeminiSettings:
    api_key: str | None
    model: str
    timeout_seconds: float
    max_attempts: int
    # Optional override of the API endpoint (e.g. a proxy, or a local mock in tests).
    base_url: str | None

    @classmethod
    def from_env(cls) -> "GeminiSettings":
        return cls(
            api_key=os.environ.get("GEMINI_API_KEY") or None,
            model=os.environ.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL,
            timeout_seconds=float(os.environ.get("GEMINI_TIMEOUT_SECONDS", "60")),
            max_attempts=max(1, int(os.environ.get("GEMINI_MAX_ATTEMPTS", "3"))),
            base_url=os.environ.get("GEMINI_BASE_URL") or None,
        )

    def __repr__(self) -> str:  # never print the key
        return f"GeminiSettings(model={self.model!r}, api_key={'<set>' if self.api_key else None})"
