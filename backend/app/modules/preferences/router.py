import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.preferences import service
from app.modules.preferences.schemas import PreferencesIn, PreferencesRead

router = APIRouter(prefix="/api/v1/profiles/{profile_id}/preferences", tags=["preferences"])

DbSession = Annotated[Session, Depends(get_db)]
NOT_FOUND = {404: {"description": "Profile not found"}}


@router.get("", response_model=PreferencesRead, responses=NOT_FOUND)
def get_preferences(profile_id: uuid.UUID, db: DbSession) -> PreferencesRead:
    """The profile's preferences (all empty until saved)."""
    try:
        return service.get(db, profile_id)
    except service.ProfileNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found") from None


@router.put("", response_model=PreferencesRead, responses=NOT_FOUND)
def save_preferences(profile_id: uuid.UUID, body: PreferencesIn, db: DbSession) -> PreferencesRead:
    """Save the preferences. Replaces everything: omitted or empty fields become "not set"."""
    try:
        return service.save(db, profile_id, body)
    except service.ProfileNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found") from None
