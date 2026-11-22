import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ApplicantPreferences(Base):
    """What the applicant has confirmed about what they want and are allowed to do.
    One row per profile; every field is optional. Used to answer application
    questions directly (never guessed by the AI)."""

    __tablename__ = "applicant_preferences"

    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    salary_expectation: Mapped[str | None] = mapped_column(String(200))
    notice_period: Mapped[str | None] = mapped_column(String(100))
    preferred_locations: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")
    # Any of: remote, hybrid, onsite
    work_arrangements: Mapped[list[str]] = mapped_column(ARRAY(String(20)), default=list, server_default="{}")
    # Countries where the applicant may work without sponsorship.
    work_authorization_countries: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")
    requires_sponsorship: Mapped[bool | None] = mapped_column(Boolean)
    change_reason: Mapped[str | None] = mapped_column(Text)
    career_goals: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:
        # Deliberately excludes the values (salary, authorization) so they don't end up in logs.
        return f"<ApplicantPreferences profile_id={self.profile_id}>"
