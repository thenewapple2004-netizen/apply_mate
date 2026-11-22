import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.profiles import service
from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import ProfileCreate, ProfileRead, ProfileUpdate

router = APIRouter(prefix="/api/v1/profiles", tags=["profiles"])

DbSession = Annotated[Session, Depends(get_db)]
NOT_FOUND = {404: {"description": "Profile not found"}}


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found")


@router.get("", response_model=list[ProfileRead])
def list_profiles(db: DbSession) -> list[Profile]:
    return service.list_profiles(db)


@router.post("", response_model=ProfileRead, status_code=status.HTTP_201_CREATED)
def create_profile(data: ProfileCreate, db: DbSession) -> Profile:
    return service.create_profile(db, data)


@router.get("/{profile_id}", response_model=ProfileRead, responses=NOT_FOUND)
def get_profile(profile_id: uuid.UUID, db: DbSession) -> Profile:
    try:
        return service.get_profile(db, profile_id)
    except service.ProfileNotFound:
        raise _not_found() from None


@router.patch("/{profile_id}", response_model=ProfileRead, responses=NOT_FOUND)
def update_profile(profile_id: uuid.UUID, data: ProfileUpdate, db: DbSession) -> Profile:
    try:
        return service.update_profile(db, profile_id, data)
    except service.ProfileNotFound:
        raise _not_found() from None


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT, responses=NOT_FOUND)
def delete_profile(profile_id: uuid.UUID, db: DbSession) -> Response:
    try:
        service.delete_profile(db, profile_id)
    except service.ProfileNotFound:
        raise _not_found() from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
