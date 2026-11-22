"""Helpers for matching an answer to a form field's options."""

import re

from app.modules.applications.schemas import FormField


def norm(text: str) -> str:
    """Lowercase letters and digits separated by single spaces."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def match_option(field: FormField, raw: str | None) -> str | None:
    """Map an answer to the exact option value, by value or label (case-insensitive)."""
    if raw is None:
        return None
    wanted = norm(raw)
    for option in field.options:
        if raw == option.value or wanted in (norm(option.value), norm(option.label)):
            return option.value
    return None
