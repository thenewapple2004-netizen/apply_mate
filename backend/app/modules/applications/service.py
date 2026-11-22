"""Prepare answers for application form fields.

Order of sources, most reliable first:
1. profile  - contact fields (name, email, phone, LinkedIn, location) taken directly
2. saved    - an answer the user approved earlier for the same question
3. ai       - Gemini, given only the profile, confirmed CV, saved answers and the JD
Everything is checked afterwards: choices must be real options on the page, and
consent/declaration checkboxes are never ticked automatically.
"""

import logging
import re
import uuid

from sqlalchemy.orm import Session

from app.modules.ai.errors import AIError
from app.modules.ai.provider import StructuredAIProvider
from app.modules.answers import service as saved
from app.modules.applications.prompts import SYSTEM_INSTRUCTION, build_prompt
from app.modules.applications.schemas import (
    AIAnswers,
    Answer,
    FormField,
    PrepareRequest,
    PrepareResponse,
)
from app.modules.cv import service as cv_service
from app.modules.cv.models import CVDetails
from app.modules.profiles.models import Profile

logger = logging.getLogger(__name__)

CHOICE_TYPES = {"select", "radio", "checkbox"}
MAX_TEXT = 5000
# Checkboxes the applicant must tick personally, never on their behalf.
_CONSENT = re.compile(r"\b(agree|consent|certify|confirm|acknowledge|accept|terms|privacy|policy|declare|attest)\b")


class ProfileNotFound(Exception):
    pass


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


# ---- 1. profile rules -------------------------------------------------------------


def profile_answer(field: FormField, profile: Profile) -> str | None:
    """Contact details straight from the profile, for clearly identified fields."""
    if field.type in CHOICE_TYPES:
        return None
    label = _norm(field.label)
    name = (profile.full_name or "").split()
    if field.type == "email" or re.search(r"\be ?mail\b", label):
        return profile.email
    if field.type == "tel" or re.search(r"\b(phone|mobile|telephone|cell)\b", label):
        return profile.phone
    if "linkedin" in label:
        return profile.linkedin_url
    if re.search(r"\b(first|given) name\b", label):
        return name[0] if name else None
    if re.search(r"\b(last|family) name\b|\bsurname\b", label):
        return name[-1] if len(name) > 1 else None
    if re.search(r"\b(company|employer|school|university|reference|referee|manager|recruiter)\b", label):
        return None
    if re.fullmatch(r"(your |full |legal |candidate |applicant )?name", label):
        return profile.full_name
    if re.search(r"\b(city|current location|location|where are you based)\b", label):
        return profile.location
    return None


# ---- 3. AI answer checks ------------------------------------------------------------


def _match_option(field: FormField, raw: str | None) -> str | None:
    """Map an answer to the exact option value, by value or label (case-insensitive)."""
    if raw is None:
        return None
    wanted = _norm(raw)
    for option in field.options:
        if raw == option.value or wanted in (_norm(option.value), _norm(option.label)):
            return option.value
    return None


def check_ai_answer(field: FormField, value: str | None, values: list[str | None]) -> Answer:
    if field.type == "checkbox":
        if _CONSENT.search(_norm(field.label)):
            return Answer(field_id=field.id, source="none", note="Please read this and tick it yourself.")
        ticks = [v for v in (_match_option(field, x) for x in values if x) if v]
        if not ticks and value:  # a single checkbox answered with "yes"/"true"
            if _norm(value) in {"yes", "true", "checked", "on"} and len(field.options) == 1:
                ticks = [field.options[0].value]
        if not ticks:
            return Answer(field_id=field.id, source="none", note="Nothing in your profile supports ticking this.")
        return Answer(field_id=field.id, values=list(dict.fromkeys(ticks)), source="ai")

    if field.type in {"select", "radio"}:
        option = _match_option(field, value)
        if option is None:
            note = "Choose an option yourself." if value else None
            return Answer(field_id=field.id, source="none", note=note)
        return Answer(field_id=field.id, value=option, source="ai")

    text = (value or "").strip()
    if not text:
        return Answer(field_id=field.id, source="none")
    return Answer(field_id=field.id, value=text[:MAX_TEXT], source="ai")


# ---- putting it together --------------------------------------------------------------


def _applicant(profile: Profile, details: CVDetails | None, answers: list) -> dict:
    return {
        "profile": {
            "full_name": profile.full_name,
            "email": profile.email,
            "phone": profile.phone,
            "location": profile.location,
            "linkedin_url": profile.linkedin_url,
        },
        "cv": cv_service.details_to_data(details).model_dump() if details else None,
        "saved_answers": [{"question": a.question, "answer": a.answer} for a in answers[:50]],
    }


def prepare(
    db: Session, provider: StructuredAIProvider, profile_id: uuid.UUID, request: PrepareRequest
) -> PrepareResponse:
    profile = db.get(Profile, profile_id)
    if profile is None:
        raise ProfileNotFound
    details = db.get(CVDetails, profile_id)
    saved_answers = saved.list_answers(db, profile_id)
    by_question = {a.question_key: a.answer for a in saved_answers}

    answers: dict[str, Answer] = {}
    for field in request.fields:
        value = profile_answer(field, profile)
        if value:
            answers[field.id] = Answer(field_id=field.id, value=value, source="profile")
            continue
        remembered = by_question.get(saved.question_key(field.label))
        if remembered:
            if field.type == "checkbox":
                ticks = [v for v in (_match_option(field, x.strip()) for x in remembered.split(";")) if v]
                if ticks and not _CONSENT.search(_norm(field.label)):
                    answers[field.id] = Answer(field_id=field.id, values=ticks, source="saved")
                    continue
            elif field.type in {"select", "radio"}:
                option = _match_option(field, remembered)
                if option:
                    answers[field.id] = Answer(field_id=field.id, value=option, source="saved")
                    continue
            else:
                answers[field.id] = Answer(field_id=field.id, value=remembered, source="saved")
                continue

    remaining = [f for f in request.fields if f.id not in answers]
    ai_used, ai_error = False, None
    if remaining:
        try:
            result = provider.generate_structured(
                system=SYSTEM_INSTRUCTION,
                prompt=build_prompt(
                    request.job.model_dump(),
                    _applicant(profile, details, saved_answers),
                    [f.model_dump() for f in remaining],
                ),
                schema=AIAnswers,
            )
            ai_used = True
            by_id = {f.id: f for f in remaining}
            for item in result.data.answers or []:
                field = by_id.get(item.field_id)
                if field is not None and field.id not in answers:
                    checked = check_ai_answer(field, item.value, item.values or [])
                    if item.note and checked.source == "none" and not checked.note:
                        checked.note = item.note[:300]
                    answers[field.id] = checked
        except AIError as exc:
            ai_error = exc.message

    for field in request.fields:
        answers.setdefault(field.id, Answer(field_id=field.id, source="none"))

    logger.info(
        "Prepared answers for profile %s: %d fields, %d answered (ai_used=%s)",
        profile_id, len(request.fields),
        sum(1 for a in answers.values() if a.source != "none"), ai_used,
    )
    return PrepareResponse(
        answers=[answers[f.id] for f in request.fields], ai_used=ai_used, ai_error=ai_error
    )
