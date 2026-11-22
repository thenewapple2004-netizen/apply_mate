"""Provider-independent AI errors. Messages are safe to show to users: they
never include prompts, responses, resume text or API keys."""


class AIError(Exception):
    message = "The AI service failed."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class AINotConfigured(AIError):
    message = "AI analysis isn't configured. Set GEMINI_API_KEY in the backend's .env file and restart it."


class AIQuotaExceeded(AIError):
    message = "The Gemini quota or rate limit has been reached. Wait a minute and try again, or check your Gemini plan."


class AIUnavailable(AIError):
    message = "The AI service is temporarily unavailable. Please try again shortly."


class AITimeout(AIUnavailable):
    message = "The AI service took too long to respond. Please try again."


class AIRejected(AIError):
    """The provider refused the request (bad key, unsupported model, blocked content...)."""

    message = "The AI service rejected the request."


class AIInvalidResponse(AIError):
    message = "The AI returned a response that couldn't be read. Please try again."
