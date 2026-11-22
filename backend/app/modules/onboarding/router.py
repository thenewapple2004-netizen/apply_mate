import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.cv import service as cv_service
from app.modules.onboarding import service
from app.modules.onboarding.schemas import OnboardingState, ReviewSubmission
from app.modules.resumes import service as resumes

router = APIRouter(prefix="/api/v1/profiles/{profile_id}/onboarding", tags=["onboarding"])

DbSession = Annotated[Session, Depends(get_db)]
NOT_FOUND = {404: {"description": "Profile (or source analysis) not found"}}


@router.get("", response_model=OnboardingState, responses=NOT_FOUND)
def get_onboarding(profile_id: uuid.UUID, db: DbSession) -> OnboardingState:
    """Where this profile is in onboarding, plus the review form when one is needed."""
    try:
        return service.get_state(db, profile_id)
    except (service.ProfileNotFound, resumes.ProfileNotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found") from None


@router.post("/confirm", response_model=OnboardingState, responses=NOT_FOUND)
def confirm_review(profile_id: uuid.UUID, body: ReviewSubmission, db: DbSession) -> OnboardingState:
    """Save the reviewed details. Fills empty contact fields and adds new CV items;
    never overwrites details that were already confirmed."""
    try:
        return service.confirm(db, profile_id, body)
    except (service.ProfileNotFound, resumes.ProfileNotFound):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found") from None
    except cv_service.NotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{exc.what} not found") from None
