import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class JobApplication(Base):
    """A job the applicant says they submitted an application for. Recorded only when
    the user confirms it, since Job Fellow can't see whether a form was really sent."""

    __tablename__ = "job_applications"
    __table_args__ = (
        # Marking the same job twice must count once.
        UniqueConstraint("profile_id", "job_key"),
        Index("ix_job_applications_profile_applied_at", "profile_id", "applied_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    job_key: Mapped[str] = mapped_column(String(64))  # sha256 of the normalized job link (or title+company)
    title: Mapped[str] = mapped_column(String(300), default="")
    company: Mapped[str] = mapped_column(String(300), default="")
    url: Mapped[str] = mapped_column(String(2000), default="")
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    def __repr__(self) -> str:
        return f"<JobApplication id={self.id} profile_id={self.profile_id}>"
