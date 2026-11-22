from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

Arrangement = Literal["remote", "hybrid", "onsite"]


def _blank_to_none(value: object) -> object:
    if isinstance(value, str):
        value = " ".join(value.split()) if "\n" not in value else value.strip()
        return value or None
    return value


def _clean_list(value: object) -> object:
    """Trim, drop blanks/nulls and case-insensitive duplicates, keep order."""
    if value is None:
        return []
    if not isinstance(value, list):
        return value
    seen: set[str] = set()
    out = []
    for item in value:
        if isinstance(item, str):
            item = " ".join(item.split())
            if not item or item.lower() in seen:
                continue
            seen.add(item.lower())
        elif item is None:
            continue
        out.append(item)
    return out


Salary = Annotated[Annotated[str, Field(max_length=200)] | None, BeforeValidator(_blank_to_none)]
Notice = Annotated[Annotated[str, Field(max_length=100)] | None, BeforeValidator(_blank_to_none)]
Reason = Annotated[Annotated[str, Field(max_length=2000)] | None, BeforeValidator(_blank_to_none)]
Places = Annotated[
    list[Annotated[str, Field(min_length=1, max_length=100)]],
    BeforeValidator(_clean_list),
    Field(max_length=30),
]
Arrangements = Annotated[list[Arrangement], BeforeValidator(_clean_list), Field(max_length=3)]


class PreferencesIn(BaseModel):
    """Every field is optional; leaving one out (or empty) means "not set"."""

    model_config = ConfigDict(extra="forbid")

    salary_expectation: Salary = None
    notice_period: Notice = None
    preferred_locations: Places = []
    work_arrangements: Arrangements = []
    work_authorization_countries: Places = []
    requires_sponsorship: bool | None = None
    change_reason: Reason = None
    career_goals: Reason = None


class PreferencesRead(PreferencesIn):
    # None until the applicant saves preferences for the first time.
    updated_at: datetime | None = None
