import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SavedAnswer(Base):
    """An answer the user approved for an application question, reused next time
    the same question appears. One answer per (profile, normalized question)."""

    __tablename__ = "saved_answers"
    __table_args__ = (UniqueConstraint("profile_id", "question_key"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    question_key: Mapped[str] = mapped_column(String(300))  # normalized question text
    question: Mapped[str] = mapped_column(String(1000))     # as shown on the form
    answer: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:
        return f"<SavedAnswer id={self.id} profile_id={self.profile_id}>"
