import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import ProfileCreate, ProfileUpdate


class ProfileNotFound(Exception):
    pass


def list_profiles(db: Session) -> list[Profile]:
    return list(db.scalars(select(Profile).order_by(Profile.created_at, Profile.id)))


def get_profile(db: Session, profile_id: uuid.UUID) -> Profile:
    profile = db.get(Profile, profile_id)
    if profile is None:
        raise ProfileNotFound
    return profile


def create_profile(db: Session, data: ProfileCreate) -> Profile:
    profile = Profile(**data.model_dump())
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


def update_profile(db: Session, profile_id: uuid.UUID, data: ProfileUpdate) -> Profile:
    profile = get_profile(db, profile_id)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    db.commit()
    db.refresh(profile)
    return profile


def delete_profile(db: Session, profile_id: uuid.UUID) -> None:
    profile = get_profile(db, profile_id)
    db.delete(profile)
    db.commit()
