import logging
import uuid

from sqlalchemy.orm import Session

from app.modules.preferences.models import ApplicantPreferences
from app.modules.preferences.schemas import PreferencesIn, PreferencesRead
from app.modules.profiles.models import Profile

logger = logging.getLogger(__name__)


class ProfileNotFound(Exception):
    pass


def get_row(db: Session, profile_id: uuid.UUID) -> ApplicantPreferences | None:
    return db.get(ApplicantPreferences, profile_id)


def get(db: Session, profile_id: uuid.UUID) -> PreferencesRead:
    if db.get(Profile, profile_id) is None:
        raise ProfileNotFound
    row = get_row(db, profile_id)
    return PreferencesRead.model_validate(row, from_attributes=True) if row else PreferencesRead()


def save(db: Session, profile_id: uuid.UUID, data: PreferencesIn) -> PreferencesRead:
    """Replace the profile's preferences with exactly what was sent."""
    if db.get(Profile, profile_id) is None:
        raise ProfileNotFound
    row = get_row(db, profile_id)
    if row is None:
        row = ApplicantPreferences(profile_id=profile_id)
        db.add(row)
    for field, value in data.model_dump().items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    logger.info("Saved preferences for profile %s", profile_id)  # never the values
    return PreferencesRead.model_validate(row, from_attributes=True)
