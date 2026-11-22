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
from app.modules.applications import cache as answer_cache
from app.modules.applications import preference_answers
from app.modules.applications.options import match_option, norm
from app.modules.applications.prompts import (
    COMPOSE_INSTRUCTION,
    SYSTEM_INSTRUCTION,
    build_compose_prompt,
    build_prompt,
)
from app.modules.applications.schemas import (
    AIAnswers,
    AIComposed,
    Answer,
    ComposeRequest,
    ComposeResponse,
    FormField,
    PrepareRequest,
    PrepareResponse,
    Suggestion,
)
from app.modules.cv import service as cv_service
from app.modules.cv.models import CVDetails
from app.modules.preferences.models import ApplicantPreferences
from app.modules.profiles.models import Profile

logger = logging.getLogger(__name__)

CHOICE_TYPES = {"select", "radio", "checkbox"}
MAX_TEXT = 5000
# Checkboxes the applicant must tick personally, never on their behalf.
_CONSENT = re.compile(r"\b(agree|consent|certify|confirm|acknowledge|accept|terms|privacy|policy|declare|attest)\b")


class ProfileNotFound(Exception):
    pass


_norm = norm


# ---- 1. profile rules -------------------------------------------------------------


CONTACT_NOTES = {
    "email": "No email in your profile. Add it with Edit details.",
    "phone": "No phone number in your profile. Add it with Edit details.",
    "linkedin": "No LinkedIn URL in your profile. Add it with Edit details.",
    "location": "No location in your profile. Add it with Edit details.",
    "last_name": "Your profile has a single name; add your last name yourself.",
}


def contact_kind(field: FormField) -> str | None:
    """Which profile contact detail a field asks for, if it clearly asks for one."""
    if field.type in CHOICE_TYPES:
        return None
    label = _norm(field.label)
    if field.type == "email" or re.search(r"\be ?mail\b", label):
        return "email"
    if field.type == "tel" or re.search(r"\b(phone|mobile|telephone|cell)\b", label):
        return "phone"
    if "linkedin" in label:
        return "linkedin"
    if re.search(r"\b(first|given) name\b", label):
        return "first_name"
    if re.search(r"\b(last|family) name\b|\bsurname\b", label):
        return "last_name"
    if re.search(r"\b(company|employer|school|university|reference|referee|manager|recruiter|preferred)\b", label):
        return None
    if re.fullmatch(r"(your |full |legal |candidate |applicant )?name", label):
        return "full_name"
    if re.search(r"\b(city|current location|location|where are you based)\b", label) and "country" not in label:
        return "location"
    return None


def profile_answer(field: FormField, profile: Profile) -> str | None:
    """Contact details straight from the profile, for clearly identified fields."""
    name = (profile.full_name or "").split()
    return {
        "email": lambda: profile.email,
        "phone": lambda: profile.phone,
        "linkedin": lambda: profile.linkedin_url,
        "first_name": lambda: name[0] if name else None,
        "last_name": lambda: name[-1] if len(name) > 1 else None,
        "full_name": lambda: profile.full_name,
        "location": lambda: profile.location,
    }.get(contact_kind(field) or "", lambda: None)()


# ---- 3. AI answer checks ------------------------------------------------------------


def _match_option(field: FormField, raw: str | None) -> str | None:
    """Map an answer to the exact option value, by value or label (case-insensitive)."""
    return match_option(field, raw)


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


TEXT_TYPES = {"text", "textarea", "number"}


_YES = re.compile(r"^\s*(yes|yeah|sure|absolutely|of course|i am|i can|i'm)\b", re.I)
_NO = re.compile(r"^\s*(no|not|i am not|i'm not|i cannot|i can't|unfortunately)\b", re.I)


def contradicts(choice: str, answer: str) -> bool:
    """True when the wording says the opposite of a yes/no choice."""
    c = choice.strip().lower()
    return bool((c in {"yes", "y"} and _NO.match(answer)) or (c in {"no", "n"} and _YES.match(answer)))


def clean_suggestions(raw: list, field_type: str) -> list[Suggestion]:
    """Up to 4 short, distinct choices, each with its pre-written answer when usable."""
    limit = 600 if field_type == "textarea" else 200
    seen: set[str] = set()
    out: list[Suggestion] = []
    for item in raw:
        if item is None:
            continue
        label = " ".join((item.choice or "").split())[:80]
        if not label or label.lower() in seen:
            continue
        seen.add(label.lower())
        answer = " ".join((item.answer or "").split())[:limit] or None
        if field_type == "number":
            answer = label if re.fullmatch(r"[\d.,]+", label) else None
        elif answer and contradicts(label, answer):
            answer = None  # never offer wording that disagrees with the choice
        out.append(Suggestion(label=label, answer=answer))
    return out[:4]


# ---- putting it together --------------------------------------------------------------


def _compact(value):
    """Drop empty values: fewer tokens in the prompt means a faster answer."""
    if isinstance(value, dict):
        return {k: c for k, v in value.items() if (c := _compact(v)) not in (None, "", [], {})}
    if isinstance(value, list):
        return [c for v in value if (c := _compact(v)) not in (None, "", [], {})]
    return value


def _applicant(
    profile: Profile, details: CVDetails | None, answers: list, prefs: ApplicantPreferences | None = None
) -> dict:
    return _compact({
        "profile": {
            "full_name": profile.full_name,
            "email": profile.email,
            "phone": profile.phone,
            "location": profile.location,
            "linkedin_url": profile.linkedin_url,
        },
        "cv": cv_service.details_to_data(details).model_dump() if details else None,
        # Only the non-sensitive preferences. Salary, work authorization and sponsorship are
        # never sent to the AI: those answers come from the preferences, with the user's approval.
        "preferences": {
            "notice_period": prefs.notice_period,
            "preferred_locations": prefs.preferred_locations,
            "work_arrangements": prefs.work_arrangements,
            "reason_for_changing_jobs": prefs.change_reason,
        } if prefs else None,
        "saved_answers": [{"question": a.question, "answer": a.answer} for a in answers[:30]],
    })


def _prompt_field(field: FormField) -> dict:
    """A field as the AI needs to see it. Options whose value equals their label are
    sent as plain strings."""
    out: dict = {"id": field.id, "label": field.label, "type": field.type}
    if field.options:
        out["options"] = [o.value if o.value == o.label else {"value": o.value, "label": o.label} for o in field.options]
    return out


def prepare(
    db: Session, provider: StructuredAIProvider, profile_id: uuid.UUID, request: PrepareRequest
) -> PrepareResponse:
    profile = db.get(Profile, profile_id)
    if profile is None:
        raise ProfileNotFound
    details = db.get(CVDetails, profile_id)
    prefs = db.get(ApplicantPreferences, profile_id)
    saved_answers = saved.list_answers(db, profile_id)
    by_question = {a.question_key: a.answer for a in saved_answers}

    answers: dict[str, Answer] = {}
    missing_pref: dict[str, str] = {}  # not-set preferences: the AI may still suggest options
    for field in request.fields:
        kind = contact_kind(field)
        if kind:
            value = profile_answer(field, profile)
            answers[field.id] = (
                Answer(field_id=field.id, value=value, source="profile")
                if value
                else Answer(field_id=field.id, source="none", note=CONTACT_NOTES.get(kind))
            )
            continue
        which = preference_answers.kind(field)
        if which:
            result = preference_answers.answer(field, which, prefs)
            unset = preference_answers.is_missing(prefs, which)
            if unset and which not in preference_answers.APPROVAL_KINDS:
                missing_pref[field.id] = which  # carry on: saved answers, then AI suggestions
            else:
                # Set (answered from the preference) or sensitive (never sent to the AI).
                answers[field.id] = result
                continue
        if saved.is_sensitive(field.label):
            # Consent and personal questions (demographics, salary...) are the applicant's to answer.
            note = (
                "Read this and tick it yourself."
                if saved.CONSENT.search(field.label)
                else "Personal question: please answer it yourself."
            )
            answers[field.id] = Answer(field_id=field.id, source="none", note=note)
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

    # Questions the AI answered before (and that haven't changed) are reused instantly.
    version = answer_cache.context_version(profile, details, prefs)
    keys = {f.id: answer_cache.cache_key(f, version, request.job) for f in request.fields if f.id not in answers}
    cache_hits = 0
    if not request.refresh:
        cached = answer_cache.lookup(db, profile_id, list(set(keys.values())))
        for field_id, key in keys.items():
            if key in cached:
                answers[field_id] = answer_cache.from_payload(field_id, cached[key])
                cache_hits += 1

    remaining = [f for f in request.fields if f.id not in answers]
    ai_used, ai_error = False, None
    if remaining:
        try:
            result = provider.generate_structured(
                system=SYSTEM_INSTRUCTION,
                prompt=build_prompt(
                    request.job.model_dump(),
                    _applicant(profile, details, saved_answers, prefs),
                    [_prompt_field(f) for f in remaining],
                ),
                schema=AIAnswers,
            )
            ai_used = True
            by_id = {f.id: f for f in remaining}
            fresh: list[tuple[str, Answer]] = []
            for item in result.data.answers or []:
                field = by_id.get(item.field_id)
                if field is not None and field.id not in answers:
                    checked = check_ai_answer(field, item.value, item.values or [])
                    if item.note and checked.source == "none" and not checked.note:
                        checked.note = item.note[:300]
                    if checked.source == "none" and field.type in TEXT_TYPES:
                        checked.suggestions = clean_suggestions(item.suggestions or [], field.type)
                    answers[field.id] = checked
                    fresh.append((keys[field.id], checked))
            answer_cache.store(db, profile_id, fresh)  # next time these are instant
        except AIError as exc:
            ai_error = exc.message

    for field in request.fields:
        answers.setdefault(field.id, Answer(field_id=field.id, source="none"))
    # A question about a preference that isn't set: say clearly where to add it (the AI may
    # still have offered options to pick from, but it never answers for the applicant).
    for field_id, which in missing_pref.items():
        if answers[field_id].source == "none":
            answers[field_id].note = preference_answers.MISSING[which]
            answers[field_id].preference = which

    logger.info(
        "Prepared answers for profile %s: %d fields, %d answered, %d from cache (ai_used=%s)",
        profile_id, len(request.fields),
        sum(1 for a in answers.values() if a.source != "none"), cache_hits, ai_used,
    )
    return PrepareResponse(
        answers=[answers[f.id] for f in request.fields],
        ai_used=ai_used,
        ai_error=ai_error,
        cache_hits=cache_hits,
        context_version=version,
    )


def current_context_version(db: Session, profile_id: uuid.UUID) -> str:
    """The version stamp of everything answers are based on (see answer_cache.context_version)."""
    profile = db.get(Profile, profile_id)
    if profile is None:
        raise ProfileNotFound
    return answer_cache.context_version(
        profile, db.get(CVDetails, profile_id), db.get(ApplicantPreferences, profile_id)
    )


# ---- writing an answer from the applicant's choice ------------------------------------


def compose(
    db: Session, provider: StructuredAIProvider, profile_id: uuid.UUID, request: ComposeRequest
) -> ComposeResponse:
    """Turn the option the applicant clicked (e.g. "Yes") into a short answer in their voice.
    The choice is the answer; the AI only words it. Raises AIError if the AI fails."""
    profile = db.get(Profile, profile_id)
    if profile is None:
        raise ProfileNotFound
    choice = " ".join(request.choice.split())
    # Personal questions and simple values are used exactly as chosen.
    if saved.is_sensitive(request.question) or request.type not in {"text", "textarea"}:
        return ComposeResponse(value=choice, composed=False)

    details = db.get(CVDetails, profile_id)
    result = provider.generate_structured(
        system=COMPOSE_INSTRUCTION,
        prompt=build_compose_prompt(
            request.job.model_dump(),
            _applicant(profile, details, []),
            request.question,
            request.type,
            choice,
        ),
        schema=AIComposed,
    )
    value = " ".join((result.data.value or "").split())[: 600 if request.type == "textarea" else 200]
    # Never let the wording contradict a yes/no choice.
    if not value or contradicts(choice, value):
        return ComposeResponse(value=choice, composed=False)
    logger.info("Composed an answer for profile %s (%s field)", profile_id, request.type)
    return ComposeResponse(value=value, composed=True)
