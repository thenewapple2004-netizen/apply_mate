import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

FieldType = Literal["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox"]
Source = Literal["profile", "preference", "cv", "saved", "ai", "none"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Job(_Strict):
    title: Annotated[str, Field(max_length=300)] = ""
    company: Annotated[str, Field(max_length=300)] = ""
    description: Annotated[str, Field(max_length=30_000)] = ""
    url: Annotated[str, Field(max_length=2000)] = ""


class Option(_Strict):
    value: Annotated[str, Field(max_length=500)]
    label: Annotated[str, Field(max_length=500)]


class FormField(_Strict):
    """A question detected on the page (sent by the extension)."""

    id: Annotated[str, Field(min_length=1, max_length=100)]
    label: Annotated[str, Field(max_length=1000)]
    type: FieldType
    required: bool = False
    options: Annotated[list[Option], Field(max_length=200)] = []


class PrepareRequest(_Strict):
    job: Job
    refresh: bool = False  # ignore remembered AI answers and ask the AI again
    fields: Annotated[list[FormField], Field(min_length=1, max_length=150)]


class Answer(BaseModel):
    field_id: str
    # Text for text-like fields; an option *value* for select/radio; for checkboxes,
    # `values` lists the option values to tick.
    value: str | None = None
    values: list[str] = []
    source: Source
    note: str | None = None
    # For unanswered text questions: short choices the applicant can pick from
    # (e.g. "Yes" / "No", "2 weeks" / "1 month"), each with the full answer to use if
    # picked. Never filled in automatically.
    suggestions: list["Suggestion"] = []
    cached: bool = False  # reused from an earlier identical question (no AI call)
    # Salary, work authorization and sponsorship answers come from the applicant's
    # preferences but are only proposals: the user must approve them before they are filled.
    needs_approval: bool = False
    # Which preference this question is about (e.g. "salary"), even when it isn't set yet.
    preference: str | None = None


class Suggestion(BaseModel):
    label: str
    answer: str | None = None  # None: the extension asks the backend to word it on click


class PrepareResponse(BaseModel):
    answers: list[Answer]
    ai_used: bool
    ai_error: str | None = None
    cache_hits: int = 0  # answers reused instantly, without the AI
    # Changes whenever the profile, CV or preferences change; the extension drops
    # answers prepared under an older version.
    context_version: str = ""


class ContextVersion(BaseModel):
    version: str


class SavedAnswerIn(_Strict):
    question: Annotated[str, Field(min_length=1, max_length=1000)]
    answer: Annotated[str, Field(max_length=10_000)]


class SaveAnswersRequest(_Strict):
    answers: Annotated[list[SavedAnswerIn], Field(max_length=150)]


class SavedAnswerRead(BaseModel):
    question: str
    answer: str


# ---- what the AI returns ----


class ComposeRequest(_Strict):
    """Write the answer to one question from the option the applicant picked."""

    job: Job
    question: Annotated[str, Field(min_length=1, max_length=1000)]
    type: FieldType
    choice: Annotated[str, Field(min_length=1, max_length=300)]


class ComposeResponse(BaseModel):
    value: str
    composed: bool  # False when the choice is used as-is (e.g. sensitive question)


class AIAnswer(BaseModel):
    field_id: str
    value: str | None = None
    values: list[str | None] | None = None
    note: str | None = None
    suggestions: list["AISuggestion | None"] | None = None


class AISuggestion(BaseModel):
    choice: str | None = None
    answer: str | None = None


class AIAnswers(BaseModel):
    answers: list[AIAnswer] | None = None


class AIComposed(BaseModel):
    value: str | None = None


# ---- applied-jobs history ----


class ApplicationIn(_Strict):
    """A job the applicant confirms they applied to."""

    title: Annotated[str, Field(max_length=300)] = ""
    company: Annotated[str, Field(max_length=300)] = ""
    url: Annotated[str, Field(max_length=2000)] = ""
    # Optional, for entering past applications; defaults to now. Must include a timezone.
    applied_at: AwareDatetime | None = None

    @field_validator("title", "company", "url", mode="before")
    @classmethod
    def _strip(cls, value: object) -> object:
        return " ".join(value.split()) if isinstance(value, str) else value

    @model_validator(mode="after")
    def _identify_the_job(self) -> "ApplicationIn":
        if not (self.title or self.url):
            raise ValueError("a job title or link is required")
        if self.applied_at and self.applied_at > datetime.now(UTC) + timedelta(minutes=5):
            raise ValueError("applied_at can't be in the future")
        return self


class ApplicationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    company: str
    url: str
    applied_at: datetime
    already_recorded: bool = False  # true when this job was already in the history


class ApplicationStats(BaseModel):
    total: int
    today: int
    last_7_days: int  # today and the six days before
    last_30_days: int
    timezone: str
