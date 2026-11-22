import os
from dataclasses import dataclass

DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
# Used when the main model's quota is used up or it is overloaded. Each Gemini
# model has its own quota, so this keeps the app working. GEMINI_FALLBACK_MODEL=none disables it.
DEFAULT_FALLBACK_MODEL = "gemini-2.5-flash"


@dataclass(frozen=True)
class GeminiSettings:
    api_key: str | None
    model: str
    timeout_seconds: float
    max_attempts: int
    # Optional override of the API endpoint (e.g. a proxy, or a local mock in tests).
    base_url: str | None
    fallback_model: str | None = None
    # Structured extraction doesn't need long reasoning; turning it off is much faster.
    thinking_off: bool = True

    @classmethod
    def from_env(cls) -> "GeminiSettings":
        model = os.environ.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL
        fallback = (os.environ.get("GEMINI_FALLBACK_MODEL") or "").strip() or DEFAULT_FALLBACK_MODEL
        if fallback.lower() in {"none", "off", "disabled"}:
            fallback = ""
        return cls(
            api_key=os.environ.get("GEMINI_API_KEY") or None,
            model=model,
            timeout_seconds=float(os.environ.get("GEMINI_TIMEOUT_SECONDS", "45")),
            max_attempts=max(1, int(os.environ.get("GEMINI_MAX_ATTEMPTS", "3"))),
            base_url=os.environ.get("GEMINI_BASE_URL") or None,
            fallback_model=fallback if fallback and fallback != model else None,
            thinking_off=os.environ.get("GEMINI_THINKING", "off").strip().lower() != "on",
        )

    def __repr__(self) -> str:  # never print the key
        return (
            f"GeminiSettings(model={self.model!r}, fallback={self.fallback_model!r}, "
            f"api_key={'<set>' if self.api_key else None})"
        )
