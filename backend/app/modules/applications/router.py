import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db.session import get_db
from app.modules.ai.provider import StructuredAIProvider, get_ai_provider
from app.modules.answers import service as saved
from app.modules.applications import service
from app.modules.applications.schemas import (
    PrepareRequest,
    PrepareResponse,
    SaveAnswersRequest,
    SavedAnswerRead,
)
from app.modules.profiles.models import Profile

router = APIRouter(prefix="/api/v1/profiles/{profile_id}", tags=["applications"])

DbSession = Annotated[Session, Depends(get_db)]
Provider = Annotated[StructuredAIProvider, Depends(get_ai_provider)]


def _require_profile(db: Session, profile_id: uuid.UUID) -> None:
    if db.get(Profile, profile_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")


@router.post(
    "/applications/answers",
    response_model=PrepareResponse,
    responses={404: {"description": "Profile not found"}},
)
async def prepare_answers(
    profile_id: uuid.UUID, body: PrepareRequest, db: DbSession, provider: Provider
) -> PrepareResponse:
    """Suggest answers for the form fields on the current page. Nothing is filled or
    saved here; the user reviews the answers in the extension first.
    If the AI is unavailable, profile and saved answers are still returned (`ai_error` says why)."""
    try:
        return await run_in_threadpool(service.prepare, db, provider, profile_id, body)
    except service.ProfileNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found") from None


@router.get("/answers", response_model=list[SavedAnswerRead])
def list_saved_answers(profile_id: uuid.UUID, db: DbSession) -> list[SavedAnswerRead]:
    _require_profile(db, profile_id)
    return [SavedAnswerRead(question=a.question, answer=a.answer) for a in saved.list_answers(db, profile_id)]


@router.put("/answers", response_model=dict)
def save_answers(profile_id: uuid.UUID, body: SaveAnswersRequest, db: DbSession) -> dict:
    """Remember approved answers (by question) for future applications."""
    _require_profile(db, profile_id)
    stored = saved.save_answers(db, profile_id, [(a.question, a.answer) for a in body.answers])
    return {"saved": stored}
