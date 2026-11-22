import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, computed_field

from app.modules.resumes.models import Resume


class ResumeRead(BaseModel):
    """Resume metadata. Excludes the extracted text, which can be large."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    profile_id: uuid.UUID
    original_filename: str
    file_type: Literal["pdf", "docx"]
    size_bytes: int
    is_primary: bool
    text_length: int
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def has_text(self) -> bool:
        return self.text_length > 0

    @classmethod
    def from_model(cls, resume: Resume) -> "ResumeRead":
        return cls.model_validate(
            {**_columns(resume), "text_length": len(resume.extracted_text)}
        )


class ResumeDetail(ResumeRead):
    extracted_text: str

    @classmethod
    def from_model(cls, resume: Resume) -> "ResumeDetail":
        return cls.model_validate(
            {**_columns(resume), "text_length": len(resume.extracted_text)}
        )


def _columns(resume: Resume) -> dict:
    return {c.key: getattr(resume, c.key) for c in Resume.__table__.columns}
