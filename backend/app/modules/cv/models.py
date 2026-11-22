"""CV analysis drafts and confirmed professional details.

- `CVAnalysis`: the latest AI draft for one resume (JSON), until the user confirms it.
  It references the resume rather than copying its text.
- `CVDetails` + child tables: the user-confirmed information, one set per profile.
  Only an explicit save changes it; a new analysis never overwrites it.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class CVAnalysis(Base):
    __tablename__ = "cv_analyses"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    # One current analysis per resume; re-analysing replaces the draft.
    resume_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("resumes.id", ondelete="CASCADE"), unique=True
    )
    status: Mapped[str] = mapped_column(String(20))  # "draft" | "confirmed"
    provider: Mapped[str] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(100))
    result: Mapped[dict] = mapped_column(JSONB)  # CVData as JSON
    # Suggested contact details (email, phone, location, linkedin_url), already validated.
    contact: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    warnings: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def __repr__(self) -> str:
        return f"<CVAnalysis id={self.id} resume_id={self.resume_id} status={self.status}>"


class CVDetails(Base):
    __tablename__ = "cv_details"

    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    summary: Mapped[str | None] = mapped_column(Text)
    skills: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    technologies: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    # Provenance. Kept (set to NULL) if the resume or draft is later deleted.
    source_resume_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("resumes.id", ondelete="SET NULL")
    )
    source_analysis_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("cv_analyses.id", ondelete="SET NULL")
    )
    confirmed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    work_experience: Mapped[list["CVWorkExperience"]] = relationship(
        cascade="all, delete-orphan", order_by="CVWorkExperience.position", lazy="selectin"
    )
    education: Mapped[list["CVEducation"]] = relationship(
        cascade="all, delete-orphan", order_by="CVEducation.position", lazy="selectin"
    )
    projects: Mapped[list["CVProject"]] = relationship(
        cascade="all, delete-orphan", order_by="CVProject.position", lazy="selectin"
    )
    certifications: Mapped[list["CVCertification"]] = relationship(
        cascade="all, delete-orphan", order_by="CVCertification.position", lazy="selectin"
    )

    def __repr__(self) -> str:
        return f"<CVDetails profile_id={self.profile_id}>"


class _Item:
    """Columns shared by the ordered child rows of CVDetails."""

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("cv_details.profile_id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)


class CVWorkExperience(_Item, Base):
    __tablename__ = "cv_work_experiences"

    company: Mapped[str | None] = mapped_column(String(300))
    title: Mapped[str | None] = mapped_column(String(300))
    location: Mapped[str | None] = mapped_column(String(300))
    start_date: Mapped[str | None] = mapped_column(String(50))
    end_date: Mapped[str | None] = mapped_column(String(50))
    is_current: Mapped[bool | None] = mapped_column(Boolean)
    responsibilities: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)


class CVEducation(_Item, Base):
    __tablename__ = "cv_educations"

    institution: Mapped[str | None] = mapped_column(String(300))
    degree: Mapped[str | None] = mapped_column(String(300))
    field_of_study: Mapped[str | None] = mapped_column(String(300))
    start_date: Mapped[str | None] = mapped_column(String(50))
    end_date: Mapped[str | None] = mapped_column(String(50))
    details: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)


class CVProject(_Item, Base):
    __tablename__ = "cv_projects"

    name: Mapped[str | None] = mapped_column(String(300))
    role: Mapped[str | None] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    technologies: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    url: Mapped[str | None] = mapped_column(String(500))


class CVCertification(_Item, Base):
    __tablename__ = "cv_certifications"

    name: Mapped[str | None] = mapped_column(String(300))
    issuer: Mapped[str | None] = mapped_column(String(300))
    date: Mapped[str | None] = mapped_column(String(50))
