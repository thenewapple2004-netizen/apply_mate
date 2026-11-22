import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.modules.cv.schemas import CVData
from app.modules.profiles.schemas import Email, LinkedInUrl, Location, Phone, ProfileRead
from app.modules.resumes.schemas import ResumeRead

Step = Literal["profile", "resume", "review", "complete"]
Section = Literal[
    "summary", "skills", "technologies", "work_experience", "education", "projects", "certifications"
]
ContactField = Literal["email", "phone", "location", "linkedin_url"]


class ContactPatch(BaseModel):
    """Contact details to fill in on the profile (same validation as a profile edit)."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    email: Email = None
    phone: Phone = None
    location: Location = None
    linkedin_url: LinkedInUrl = None


class ReviewForm(BaseModel):
    """Only what still needs the user's attention.

    - `contact_fields`: profile fields that are empty; `contact` holds AI suggestions for them.
    - `sections`: CV sections to show; `cv` holds only items not already confirmed.
    """

    contact_fields: list[ContactField]
    contact: dict[str, str | None]
    sections: list[Section]
    cv: CVData
    source_analysis_id: uuid.UUID | None
    warnings: list[str]


class AnalysisSummary(BaseModel):
    id: uuid.UUID
    status: Literal["draft", "confirmed"]
    model: str
    analyzed_at: datetime


class OnboardingState(BaseModel):
    step: Step
    profile: ProfileRead
    resume: ResumeRead | None
    resume_count: int
    cv: CVData | None  # confirmed details, if any
    analysis: AnalysisSummary | None  # for the current resume
    review: ReviewForm | None


class ReviewSubmission(BaseModel):
    """What the user confirmed in the review form. Items are added to (never replace)
    already-confirmed details; contact values fill the profile's empty fields."""

    model_config = ConfigDict(extra="forbid")

    contact: ContactPatch = ContactPatch()
    cv: CVData = CVData()
    source_analysis_id: uuid.UUID | None = None
