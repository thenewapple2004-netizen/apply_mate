import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    false,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Resume(Base):
    """An uploaded resume. Belongs to exactly one profile; the file itself lives in
    resume storage (see storage.py), and this row holds its metadata and text."""

    __tablename__ = "resumes"
    __table_args__ = (
        # At most one primary resume per profile, enforced by the database.
        Index(
            "uq_resumes_one_primary_per_profile",
            "profile_id",
            unique=True,
            postgresql_where=text("is_primary"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    original_filename: Mapped[str] = mapped_column(String(255))
    file_type: Mapped[str] = mapped_column(String(10))  # "pdf" or "docx"
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(200))  # path relative to the storage dir
    extracted_text: Mapped[str] = mapped_column(Text)
    is_primary: Mapped[bool] = mapped_column(Boolean, server_default=false(), default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:
        # Deliberately excludes the filename and text so they don't end up in logs.
        return f"<Resume id={self.id} profile_id={self.profile_id}>"
