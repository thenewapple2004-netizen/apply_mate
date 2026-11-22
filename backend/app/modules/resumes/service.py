"""Resume operations. Every lookup is scoped to a profile ID, so a resume can
only be reached through the profile it belongs to."""

import hashlib
import logging
import re
import unicodedata
import uuid

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.modules.profiles.models import Profile
from app.modules.resumes import storage
from app.modules.resumes.extraction import UnreadableFile, detect_file_type, extract_text
from app.modules.resumes.models import Resume

logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


class ProfileNotFound(Exception):
    pass


class ResumeNotFound(Exception):
    pass


def _require_profile(db: Session, profile_id: uuid.UUID) -> None:
    if db.get(Profile, profile_id) is None:
        raise ProfileNotFound


def list_resumes(db: Session, profile_id: uuid.UUID) -> list[Resume]:
    _require_profile(db, profile_id)
    query = (
        select(Resume)
        .where(Resume.profile_id == profile_id)
        .order_by(Resume.created_at, Resume.id)
    )
    return list(db.scalars(query))


def get_resume(db: Session, profile_id: uuid.UUID, resume_id: uuid.UUID) -> Resume:
    _require_profile(db, profile_id)
    resume = db.scalar(
        select(Resume).where(Resume.id == resume_id, Resume.profile_id == profile_id)
    )
    if resume is None:
        raise ResumeNotFound
    return resume


def create_resume(db: Session, profile_id: uuid.UUID, filename: str, data: bytes) -> Resume:
    """Validate, extract and store a resume. Raises ResumeFileError for bad files."""
    _require_profile(db, profile_id)
    if not data:
        raise UnreadableFile("empty", "The file is empty.")

    safe_name = clean_filename(filename)
    file_type = detect_file_type(data, safe_name)
    extraction = extract_text(data, file_type)

    resume_id = uuid.uuid4()
    key = storage.storage_key(profile_id, resume_id, file_type)
    storage.save(key, data)
    resume = Resume(
        id=resume_id,
        profile_id=profile_id,
        original_filename=safe_name,
        file_type=file_type,
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        storage_key=key,
        extracted_text=extraction.text,
    )
    try:
        db.add(resume)
        db.commit()
    except Exception:
        db.rollback()
        storage.delete(key)  # don't leave an orphaned file behind
        raise
    db.refresh(resume)
    # IDs and sizes only: never the filename or the text.
    logger.info(
        "Stored resume %s for profile %s (%s, %d bytes, %d chars)",
        resume.id, profile_id, file_type, len(data), len(extraction.text),
    )
    return resume


def set_primary(db: Session, profile_id: uuid.UUID, resume_id: uuid.UUID, primary: bool) -> Resume:
    resume = get_resume(db, profile_id, resume_id)
    if primary:
        # Clear the old primary first, so the one-primary-per-profile index is never violated.
        db.execute(
            update(Resume)
            .where(Resume.profile_id == profile_id, Resume.is_primary, Resume.id != resume_id)
            .values(is_primary=False)
        )
    resume.is_primary = primary
    db.commit()
    db.refresh(resume)
    return resume


def delete_resume(db: Session, profile_id: uuid.UUID, resume_id: uuid.UUID) -> None:
    resume = get_resume(db, profile_id, resume_id)
    key = resume.storage_key
    db.delete(resume)
    db.commit()
    storage.delete(key)


def clean_filename(filename: str | None) -> str:
    """A display-safe version of the uploaded filename (it is never used as a path)."""
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = unicodedata.normalize("NFC", name)
    # Control characters (tabs, bells, ...) become spaces, then runs of spaces collapse.
    name = "".join(" " if unicodedata.category(ch)[0] == "C" else ch for ch in name)
    name = re.sub(r"\s+", " ", name).strip()
    if len(name) > 255:
        stem, dot, ext = name.rpartition(".")
        keep = 255 - len(dot + ext)
        name = (stem[:keep] + dot + ext) if dot and keep > 0 else name[:255]
    return name or "resume"
