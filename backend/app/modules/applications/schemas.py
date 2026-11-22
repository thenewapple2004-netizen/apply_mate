from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

FieldType = Literal["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox"]
Source = Literal["profile", "cv", "saved", "ai", "none"]


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


class Suggestion(BaseModel):
    label: str
    answer: str | None = None  # None: the extension asks the backend to word it on click


class PrepareResponse(BaseModel):
    answers: list[Answer]
    ai_used: bool
    ai_error: str | None = None
    cache_hits: int = 0  # answers reused instantly, without the AI


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
