import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db.session import get_db
from app.modules.ai.provider import StructuredAIProvider, get_ai_provider
from app.modules.answers import service as saved
from app.modules.applications import service
from app.modules.ai.errors import AIError, AIInvalidResponse, AIQuotaExceeded, AIRejected, AITimeout
from app.modules.applications.schemas import (
    ComposeRequest,
    ComposeResponse,
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


_AI_STATUS = {
    AIQuotaExceeded: status.HTTP_429_TOO_MANY_REQUESTS,
    AITimeout: status.HTTP_504_GATEWAY_TIMEOUT,
    AIInvalidResponse: status.HTTP_502_BAD_GATEWAY,
    AIRejected: status.HTTP_502_BAD_GATEWAY,
}


@router.post(
    "/applications/answers/compose",
    response_model=ComposeResponse,
    responses={404: {"description": "Profile not found"}, 429: {}, 502: {}, 503: {}, 504: {}},
)
async def compose_answer(
    profile_id: uuid.UUID, body: ComposeRequest, db: DbSession, provider: Provider
) -> ComposeResponse:
    """Write a short answer from the option the applicant clicked (e.g. "Yes"),
    keeping that choice. Sensitive questions return the choice unchanged."""
    try:
        return await run_in_threadpool(service.compose, db, provider, profile_id, body)
    except service.ProfileNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found") from None
    except AIError as exc:
        code = next((c for t, c in _AI_STATUS.items() if isinstance(exc, t)), status.HTTP_503_SERVICE_UNAVAILABLE)
        raise HTTPException(code, exc.message) from None


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
