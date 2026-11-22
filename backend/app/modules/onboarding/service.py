"""Onboarding: profile -> resume -> review -> complete.

The step is derived from saved data, so reopening the extension never repeats
finished steps:
- no resume yet           -> "resume"
- no confirmed CV details -> "review"
- otherwise               -> "complete" (a pending AI draft still offers a review)
"""

import re
import unicodedata
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.cv import service as cv_service
from app.modules.cv.contact import CONTACT_FIELDS
from app.modules.cv.models import CVAnalysis, CVDetails
from app.modules.cv.schemas import ConfirmRequest, CVData
from app.modules.onboarding.schemas import (
    AnalysisSummary,
    OnboardingState,
    ReviewForm,
    ReviewSubmission,
)
from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import ProfileRead
from app.modules.resumes import service as resumes
from app.modules.resumes.models import Resume
from app.modules.resumes.schemas import ResumeRead

SECTIONS = ("summary", "skills", "technologies", "work_experience", "education", "projects", "certifications")
LIST_SECTIONS = ("skills", "technologies")
ENTRY_SECTIONS = ("work_experience", "education", "projects", "certifications")


class ProfileNotFound(Exception):
    pass


# ---- matching helpers --------------------------------------------------------


def _norm(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _entry_key(section: str, entry) -> tuple:
    """Identity of a CV entry, used to recognise items that are already confirmed."""
    if section == "work_experience":
        key = (_norm(entry.company), _norm(entry.title), _norm(entry.start_date))
    elif section == "education":
        key = (_norm(entry.institution), _norm(entry.degree))
    else:  # projects, certifications
        key = (_norm(entry.name),)
    # An entry with no identifying text at all is compared by its full content.
    return key if any(key) else (repr(entry.model_dump()),)


def _plain(item):
    """A list item as plain data (strings stay strings; entries become dicts)."""
    return item.model_dump() if hasattr(item, "model_dump") else item


def _new_items(section: str, candidates: list, confirmed: list) -> list:
    if section in LIST_SECTIONS:
        known = {_norm(item) for item in confirmed}
        return [item for item in candidates if _norm(item) not in known]
    known = {_entry_key(section, item) for item in confirmed}
    return [item for item in candidates if _entry_key(section, item) not in known]


# ---- state -----------------------------------------------------------------------


def current_resume(db: Session, profile_id: uuid.UUID) -> tuple[Resume | None, int]:
    """The primary resume, or else the most recently uploaded one."""
    items = resumes.list_resumes(db, profile_id)
    primary = next((r for r in items if r.is_primary), None)
    return (primary or (items[-1] if items else None)), len(items)


def get_state(db: Session, profile_id: uuid.UUID) -> OnboardingState:
    profile = db.get(Profile, profile_id)
    if profile is None:
        raise ProfileNotFound
    resume, count = current_resume(db, profile_id)
    details = db.get(CVDetails, profile_id)
    confirmed = cv_service.details_to_data(details) if details else None
    analysis = (
        db.scalar(select(CVAnalysis).where(CVAnalysis.resume_id == resume.id)) if resume else None
    )

    if resume is None:
        step = "resume"
    elif confirmed is None:
        step = "review"
    else:
        step = "complete"

    draft = analysis if analysis is not None and analysis.status == "draft" else None
    review = None
    if step == "review" or (step == "complete" and draft is not None):
        review = build_review(profile, confirmed, draft)

    return OnboardingState(
        step=step,
        profile=ProfileRead.model_validate(profile),
        resume=ResumeRead.from_model(resume) if resume else None,
        resume_count=count,
        cv=confirmed,
        analysis=(
            AnalysisSummary(
                id=analysis.id, status=analysis.status, model=analysis.model, analyzed_at=analysis.updated_at
            )
            if analysis
            else None
        ),
        review=review,
    )


def build_review(profile: Profile, confirmed: CVData | None, draft: CVAnalysis | None) -> ReviewForm:
    suggestion = CVData.model_validate(draft.result) if draft else CVData()
    suggested_contact = dict(draft.contact or {}) if draft else {}

    contact_fields = [f for f in CONTACT_FIELDS if not getattr(profile, f)]
    contact = {f: suggested_contact.get(f) for f in contact_fields}

    if confirmed is None:
        # First review: everything is unconfirmed.
        return ReviewForm(
            contact_fields=contact_fields,
            contact=contact,
            sections=list(SECTIONS),
            cv=suggestion,
            source_analysis_id=draft.id if draft else None,
            warnings=list(draft.warnings or []) if draft else [],
        )

    filtered: dict = {"summary": suggestion.summary if not confirmed.summary else None}
    sections: list[str] = ["summary"] if not confirmed.summary else []
    for section in LIST_SECTIONS + ENTRY_SECTIONS:
        new = _new_items(section, getattr(suggestion, section), getattr(confirmed, section))
        filtered[section] = [_plain(item) for item in new]
        if new or not getattr(confirmed, section):
            sections.append(section)

    return ReviewForm(
        contact_fields=contact_fields,
        contact=contact,
        sections=[s for s in SECTIONS if s in sections],
        cv=CVData.model_validate(filtered),
        source_analysis_id=draft.id if draft else None,
        warnings=list(draft.warnings or []) if draft else [],
    )


# ---- confirmation ------------------------------------------------------------------


def merge(confirmed: CVData, additions: CVData) -> CVData:
    """Add the confirmed review items to existing details without replacing any."""
    merged = confirmed.model_dump()
    if additions.summary:
        merged["summary"] = additions.summary
    for section in LIST_SECTIONS + ENTRY_SECTIONS:
        existing = getattr(confirmed, section)
        new = _new_items(section, getattr(additions, section), existing)
        merged[section] = [_plain(item) for item in existing + new]
    return CVData.model_validate(merged)


def confirm(db: Session, profile_id: uuid.UUID, body: ReviewSubmission) -> OnboardingState:
    """Save the reviewed details: fill empty contact fields and add new CV items,
    in a single transaction. Already-confirmed values are never overwritten."""
    profile = db.get(Profile, profile_id)
    if profile is None:
        raise ProfileNotFound

    for field, value in body.contact.model_dump(exclude_none=True).items():
        if not getattr(profile, field):  # only fill what's missing
            setattr(profile, field, value)

    details = db.get(CVDetails, profile_id)
    confirmed = cv_service.details_to_data(details) if details else CVData()
    merged = merge(confirmed, body.cv)
    # save_details commits the contact changes above together with the CV details.
    cv_service.save_details(
        db,
        profile_id,
        ConfirmRequest.model_validate(
            {**merged.model_dump(), "source_analysis_id": body.source_analysis_id}
        ),
    )
    return get_state(db, profile_id)
