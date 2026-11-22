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
    fields: Annotated[list[FormField], Field(min_length=1, max_length=150)]


class Answer(BaseModel):
    field_id: str
    # Text for text-like fields; an option *value* for select/radio; for checkboxes,
    # `values` lists the option values to tick.
    value: str | None = None
    values: list[str] = []
    source: Source
    note: str | None = None


class PrepareResponse(BaseModel):
    answers: list[Answer]
    ai_used: bool
    ai_error: str | None = None


class SavedAnswerIn(_Strict):
    question: Annotated[str, Field(min_length=1, max_length=1000)]
    answer: Annotated[str, Field(max_length=10_000)]


class SaveAnswersRequest(_Strict):
    answers: Annotated[list[SavedAnswerIn], Field(max_length=150)]


class SavedAnswerRead(BaseModel):
    question: str
    answer: str


# ---- what the AI returns ----


class AIAnswer(BaseModel):
    field_id: str
    value: str | None = None
    values: list[str | None] | None = None
    note: str | None = None


class AIAnswers(BaseModel):
    answers: list[AIAnswer] | None = None
