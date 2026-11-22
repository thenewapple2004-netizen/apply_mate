"""Structured CV information.

`CVExtraction` is the plain shape Gemini is asked to return. `CVData` is the
validated, size-limited version used for drafts, user edits and saved details.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field


# ---- What the AI returns (no constraints: Gemini's schema support is limited) ----

class _AIWork(BaseModel):
    company: str | None = None
    title: str | None = None
    location: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    is_current: bool | None = None
    responsibilities: list[str] = []


class _AIEducation(BaseModel):
    institution: str | None = None
    degree: str | None = None
    field_of_study: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    details: list[str] = []


class _AIProject(BaseModel):
    name: str | None = None
    role: str | None = None
    description: str | None = None
    technologies: list[str] = []
    url: str | None = None


class _AICertification(BaseModel):
    name: str | None = None
    issuer: str | None = None
    date: str | None = None


class _AIContact(BaseModel):
    full_name: str | None = None
    email: str | None = None
    phone: str | None = None
    location: str | None = None
    linkedin_url: str | None = None


class CVExtraction(BaseModel):
    contact: _AIContact = _AIContact()
    summary: str | None = None
    skills: list[str] = []
    technologies: list[str] = []
    work_experience: list[_AIWork] = []
    education: list[_AIEducation] = []
    projects: list[_AIProject] = []
    certifications: list[_AICertification] = []


# ---- Validated CV data (drafts, edits, saved details) ----


def _clean(value: object) -> object:
    if isinstance(value, str):
        value = " ".join(value.split()) if "\n" not in value else value.strip()
        return value or None
    return value


def _clean_list(value: object) -> object:
    """Trim items, drop blanks/nulls and case-insensitive duplicates, keep order."""
    if not isinstance(value, list):
        return value
    seen: set[str] = set()
    out = []
    for item in value:
        if item is None:
            continue
        if isinstance(item, str):
            item = item.strip()
            if not item or item.lower() in seen:
                continue
            seen.add(item.lower())
        out.append(item)
    return out


ShortText = Annotated[Annotated[str, Field(max_length=300)] | None, BeforeValidator(_clean)]
DateText = Annotated[Annotated[str, Field(max_length=50)] | None, BeforeValidator(_clean)]
LongText = Annotated[Annotated[str, Field(max_length=5000)] | None, BeforeValidator(_clean)]
ItemList = Annotated[
    list[Annotated[str, Field(min_length=1, max_length=1000)]],
    BeforeValidator(_clean_list),
    Field(max_length=200),
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkExperience(_Strict):
    company: ShortText = None
    title: ShortText = None
    location: ShortText = None
    start_date: DateText = None
    end_date: DateText = None
    is_current: bool | None = None
    responsibilities: ItemList = []


class Education(_Strict):
    institution: ShortText = None
    degree: ShortText = None
    field_of_study: ShortText = None
    start_date: DateText = None
    end_date: DateText = None
    details: ItemList = []


class Project(_Strict):
    name: ShortText = None
    role: ShortText = None
    description: LongText = None
    technologies: ItemList = []
    # The length limit applies to the text only, so an explicit null is accepted.
    url: Annotated[Annotated[str, Field(max_length=500)] | None, BeforeValidator(_clean)] = None


class Certification(_Strict):
    name: ShortText = None
    issuer: ShortText = None
    date: DateText = None


class CVData(_Strict):
    summary: LongText = None
    skills: ItemList = []
    technologies: ItemList = []
    work_experience: Annotated[list[WorkExperience], Field(max_length=50)] = []
    education: Annotated[list[Education], Field(max_length=30)] = []
    projects: Annotated[list[Project], Field(max_length=50)] = []
    certifications: Annotated[list[Certification], Field(max_length=50)] = []


# ---- API models ----


class AnalyzeRequest(_Strict):
    consent: bool = Field(
        description="Must be true: the user agreed to send the resume text to the external AI provider."
    )


class AnalysisRead(BaseModel):
    """An AI draft. Nothing in it is saved to the profile until the user confirms."""

    id: uuid.UUID
    profile_id: uuid.UUID
    resume_id: uuid.UUID
    status: Literal["draft", "confirmed"]
    provider: str
    model: str
    data: CVData
    contact: dict[str, str] = {}
    warnings: list[str]
    analyzed_at: datetime
    confirmed_at: datetime | None


class ConfirmRequest(CVData):
    """The reviewed CV information to save. `source_analysis_id` links it to the draft it came from."""

    source_analysis_id: uuid.UUID | None = None


class CVDetailsRead(CVData):
    profile_id: uuid.UUID
    source_resume_id: uuid.UUID | None
    source_analysis_id: uuid.UUID | None
    confirmed_at: datetime
    updated_at: datetime
