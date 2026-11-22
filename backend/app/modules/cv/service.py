"""CV analysis and confirmed CV details. Every operation is scoped to a profile ID."""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.ai.errors import AIInvalidResponse
from app.modules.ai.provider import StructuredAIProvider
from app.modules.cv.grounding import find_ungrounded
from app.modules.cv.models import (
    CVAnalysis,
    CVCertification,
    CVDetails,
    CVEducation,
    CVProject,
    CVWorkExperience,
)
from app.modules.cv.prompts import SYSTEM_INSTRUCTION, build_prompt
from app.modules.cv.schemas import ConfirmRequest, CVData, CVExtraction
from app.modules.profiles.models import Profile
from app.modules.resumes import service as resumes

logger = logging.getLogger(__name__)


class NotFound(Exception):
    def __init__(self, what: str) -> None:
        super().__init__(what)
        self.what = what


class ResumeHasNoText(Exception):
    pass


def _require_profile(db: Session, profile_id: uuid.UUID) -> None:
    if db.get(Profile, profile_id) is None:
        raise NotFound("Profile")


def _resume(db: Session, profile_id: uuid.UUID, resume_id: uuid.UUID):
    try:
        return resumes.get_resume(db, profile_id, resume_id)
    except resumes.ProfileNotFound:
        raise NotFound("Profile") from None
    except resumes.ResumeNotFound:
        raise NotFound("Resume") from None


# ---- analysis (draft) ------------------------------------------------------


def analyze_resume(
    db: Session, provider: StructuredAIProvider, profile_id: uuid.UUID, resume_id: uuid.UUID
) -> CVAnalysis:
    """Send the resume's text to the AI provider and store the result as a draft.
    Confirmed CV details are never changed here. Raises AIError on provider failure."""
    resume = _resume(db, profile_id, resume_id)
    if not resume.extracted_text.strip():
        raise ResumeHasNoText

    result = provider.generate_structured(
        system=SYSTEM_INSTRUCTION, prompt=build_prompt(resume.extracted_text), schema=CVExtraction
    )
    try:
        data = CVData.model_validate(result.data.model_dump())
    except ValueError:
        # The AI produced something outside the limits (e.g. absurdly long fields).
        raise AIInvalidResponse() from None
    warnings = find_ungrounded(data, resume.extracted_text)

    analysis = db.scalar(select(CVAnalysis).where(CVAnalysis.resume_id == resume.id))
    if analysis is None:
        analysis = CVAnalysis(profile_id=profile_id, resume_id=resume.id)
        db.add(analysis)
    analysis.status = "draft"
    analysis.provider = provider.name
    analysis.model = result.model
    analysis.result = data.model_dump(mode="json")
    analysis.warnings = warnings
    analysis.confirmed_at = None
    db.commit()
    db.refresh(analysis)
    logger.info(
        "Created CV draft %s for resume %s (model=%s, %d warnings)",
        analysis.id, resume.id, result.model, len(warnings),
    )
    return analysis


def get_analysis(db: Session, profile_id: uuid.UUID, resume_id: uuid.UUID) -> CVAnalysis:
    resume = _resume(db, profile_id, resume_id)
    analysis = db.scalar(
        select(CVAnalysis).where(
            CVAnalysis.resume_id == resume.id, CVAnalysis.profile_id == profile_id
        )
    )
    if analysis is None:
        raise NotFound("Analysis")
    return analysis


# ---- confirmed details -----------------------------------------------------


def get_details(db: Session, profile_id: uuid.UUID) -> CVDetails:
    _require_profile(db, profile_id)
    details = db.get(CVDetails, profile_id)
    if details is None:
        raise NotFound("CV details")
    return details


def save_details(db: Session, profile_id: uuid.UUID, body: ConfirmRequest) -> CVDetails:
    """Replace the profile's confirmed CV details with what the user reviewed."""
    _require_profile(db, profile_id)
    source_analysis: CVAnalysis | None = None
    if body.source_analysis_id is not None:
        source_analysis = db.get(CVAnalysis, body.source_analysis_id)
        # A draft can only be confirmed into the profile it belongs to.
        if source_analysis is None or source_analysis.profile_id != profile_id:
            raise NotFound("Analysis")

    now = datetime.now(UTC)
    details = db.get(CVDetails, profile_id)
    if details is None:
        details = CVDetails(profile_id=profile_id)
        db.add(details)

    data = CVData.model_validate(body.model_dump(exclude={"source_analysis_id"}))
    details.summary = data.summary
    details.skills = data.skills
    details.technologies = data.technologies
    details.work_experience = [
        CVWorkExperience(position=i, **item.model_dump()) for i, item in enumerate(data.work_experience)
    ]
    details.education = [
        CVEducation(position=i, **item.model_dump()) for i, item in enumerate(data.education)
    ]
    details.projects = [
        CVProject(position=i, **item.model_dump()) for i, item in enumerate(data.projects)
    ]
    details.certifications = [
        CVCertification(position=i, **item.model_dump()) for i, item in enumerate(data.certifications)
    ]
    details.confirmed_at = now
    if source_analysis is not None:
        details.source_analysis_id = source_analysis.id
        details.source_resume_id = source_analysis.resume_id
        source_analysis.status = "confirmed"
        source_analysis.confirmed_at = now
    db.commit()
    db.refresh(details)
    logger.info("Saved confirmed CV details for profile %s", profile_id)
    return details


def details_to_data(details: CVDetails) -> CVData:
    def rows(items, exclude=("id", "profile_id", "position")):
        return [
            {c: getattr(item, c) for c in item.__table__.columns.keys() if c not in exclude}
            for item in items
        ]

    return CVData.model_validate(
        {
            "summary": details.summary,
            "skills": list(details.skills or []),
            "technologies": list(details.technologies or []),
            "work_experience": rows(details.work_experience),
            "education": rows(details.education),
            "projects": rows(details.projects),
            "certifications": rows(details.certifications),
        }
    )
