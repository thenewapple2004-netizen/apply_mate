"""Turn AI-suggested contact details into values that are safe to offer the user.

Each suggestion must pass the same validation as a profile edit; a LinkedIn
address without a scheme is completed with https://. Suggestions that still
don't validate are dropped. Values not found in the resume text are kept but
flagged, like other unverified facts.
"""

import re

from pydantic import ValidationError

from app.modules.cv.schemas import CVExtraction
from app.modules.profiles.schemas import ProfileUpdate

CONTACT_FIELDS = ("email", "phone", "location", "linkedin_url")


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


def clean_contact(extraction: CVExtraction, resume_text: str) -> tuple[dict[str, str], list[str]]:
    raw = extraction.contact.model_dump()
    suggestions: dict[str, str] = {}
    warnings: list[str] = []
    lowered = resume_text.lower()

    for field in CONTACT_FIELDS:
        value = (raw.get(field) or "").strip()
        if not value:
            continue
        if field == "linkedin_url" and not value.lower().startswith(("http://", "https://")):
            value = "https://" + value
        try:
            value = getattr(ProfileUpdate.model_validate({field: value}), field)
        except ValidationError:
            continue
        if value is None:
            continue
        suggestions[field] = value

        if field == "email" and value.lower() not in lowered:
            warnings.append(f'Email "{value}" wasn\'t found in the resume text.')
        elif field == "phone" and _digits(value) and _digits(value) not in _digits(resume_text):
            warnings.append(f'Phone "{value}" wasn\'t found in the resume text.')
        elif field == "linkedin_url":
            handle = value.rstrip("/").rsplit("/", 1)[-1].lower()
            if handle and handle not in lowered:
                warnings.append(f'LinkedIn "{value}" wasn\'t found in the resume text.')
    return suggestions, warnings
