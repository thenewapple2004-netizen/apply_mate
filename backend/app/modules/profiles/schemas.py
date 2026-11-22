import re
import uuid
from datetime import datetime
from typing import Annotated
from urllib.parse import urlparse

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    model_validator,
)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^\+?[0-9 ()\-.]{5,40}$")


def _blank_to_none(value: object) -> object:
    """Treat "" / whitespace-only as "not provided" for optional fields."""
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _check_email(value: str | None) -> str | None:
    if value is not None and not _EMAIL_RE.fullmatch(value):
        raise ValueError("must be a valid email address")
    return value


def _check_phone(value: str | None) -> str | None:
    if value is not None and not _PHONE_RE.fullmatch(value):
        raise ValueError("may contain only digits, spaces, + ( ) - and .")
    return value


def _check_linkedin(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not (
        host == "linkedin.com" or host.endswith(".linkedin.com")
    ):
        raise ValueError("must be a linkedin.com URL starting with https://")
    return value


FullName = Annotated[str, Field(min_length=1, max_length=200)]

# Optional text: blank becomes None first; the length limit applies only to real text.
# Lengths match the column sizes in models.py.
Email = Annotated[
    Annotated[str, Field(max_length=320)] | None,
    BeforeValidator(_blank_to_none),
    AfterValidator(_check_email),
]
Phone = Annotated[
    Annotated[str, Field(max_length=40)] | None,
    BeforeValidator(_blank_to_none),
    AfterValidator(_check_phone),
]
Location = Annotated[
    Annotated[str, Field(max_length=200)] | None,
    BeforeValidator(_blank_to_none),
]
LinkedInUrl = Annotated[
    Annotated[str, Field(max_length=500)] | None,
    BeforeValidator(_blank_to_none),
    AfterValidator(_check_linkedin),
]


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProfileCreate(_Input):
    full_name: FullName
    email: Email = None
    phone: Phone = None
    location: Location = None
    linkedin_url: LinkedInUrl = None


class ProfileUpdate(_Input):
    """Partial update: only the fields sent are changed. Send null or "" to clear an optional field."""

    full_name: FullName | None = None
    email: Email = None
    phone: Phone = None
    location: Location = None
    linkedin_url: LinkedInUrl = None

    @model_validator(mode="after")
    def _full_name_not_cleared(self) -> "ProfileUpdate":
        if "full_name" in self.model_fields_set and self.full_name is None:
            raise ValueError("full_name can't be removed")
        return self


class ProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    full_name: str
    email: str | None
    phone: str | None
    location: str | None
    linkedin_url: str | None
    created_at: datetime
    updated_at: datetime
