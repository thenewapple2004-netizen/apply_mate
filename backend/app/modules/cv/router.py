import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db.session import get_db
from app.modules.ai.errors import (
    AIError,
    AIInvalidResponse,
    AINotConfigured,
    AIQuotaExceeded,
    AIRejected,
    AITimeout,
)
from app.modules.ai.provider import StructuredAIProvider, get_ai_provider
from app.modules.cv import service
from app.modules.cv.models import CVAnalysis, CVDetails
from app.modules.cv.schemas import (
    AnalysisRead,
    AnalyzeRequest,
    ConfirmRequest,
    CVData,
    CVDetailsRead,
)

router = APIRouter(prefix="/api/v1/profiles/{profile_id}", tags=["cv"])

DbSession = Annotated[Session, Depends(get_db)]
Provider = Annotated[StructuredAIProvider, Depends(get_ai_provider)]


def _not_found(exc: service.NotFound) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{exc.what} not found")


def _ai_http_error(exc: AIError) -> HTTPException:
    code = status.HTTP_503_SERVICE_UNAVAILABLE
    if isinstance(exc, AIQuotaExceeded):
        code = status.HTTP_429_TOO_MANY_REQUESTS
    elif isinstance(exc, AITimeout):
        code = status.HTTP_504_GATEWAY_TIMEOUT
    elif isinstance(exc, (AIInvalidResponse, AIRejected)):
        code = status.HTTP_502_BAD_GATEWAY
    elif isinstance(exc, AINotConfigured):
        code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HTTPException(status_code=code, detail=exc.message)


def _analysis_read(analysis: CVAnalysis) -> AnalysisRead:
    return AnalysisRead(
        id=analysis.id,
        profile_id=analysis.profile_id,
        resume_id=analysis.resume_id,
        status=analysis.status,
        provider=analysis.provider,
        model=analysis.model,
        data=CVData.model_validate(analysis.result),
        contact=dict(analysis.contact or {}),
        warnings=list(analysis.warnings or []),
        analyzed_at=analysis.updated_at,
        confirmed_at=analysis.confirmed_at,
    )


def _details_read(details: CVDetails) -> CVDetailsRead:
    return CVDetailsRead(
        **service.details_to_data(details).model_dump(),
        profile_id=details.profile_id,
        source_resume_id=details.source_resume_id,
        source_analysis_id=details.source_analysis_id,
        confirmed_at=details.confirmed_at,
        updated_at=details.updated_at,
    )


AI_ERRORS = {
    429: {"description": "AI quota or rate limit reached"},
    502: {"description": "AI returned an invalid response or rejected the request"},
    503: {"description": "AI not configured or unavailable"},
    504: {"description": "AI timed out"},
}


@router.post(
    "/resumes/{resume_id}/analysis",
    response_model=AnalysisRead,
    status_code=status.HTTP_201_CREATED,
    responses={404: {"description": "Profile or resume not found"}, **AI_ERRORS},
)
async def analyze_resume(
    profile_id: uuid.UUID,
    resume_id: uuid.UUID,
    body: AnalyzeRequest,
    db: DbSession,
    provider: Provider,
) -> AnalysisRead:
    """Send the resume's extracted text to the AI provider and store a **draft**.
    Requires `consent: true`. Never changes the profile's confirmed CV details."""
    if not body.consent:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Consent is required before sending the resume to the AI provider.",
        )
    try:
        # The AI call is slow and blocking; keep it off the event loop.
        analysis = await run_in_threadpool(service.analyze_resume, db, provider, profile_id, resume_id)
    except service.NotFound as exc:
        raise _not_found(exc) from None
    except service.ResumeHasNoText:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="This resume has no readable text to analyze.",
        ) from None
    except AIError as exc:
        raise _ai_http_error(exc) from None
    return _analysis_read(analysis)


@router.get(
    "/resumes/{resume_id}/analysis",
    response_model=AnalysisRead,
    responses={404: {"description": "Profile, resume or analysis not found"}},
)
def get_analysis(profile_id: uuid.UUID, resume_id: uuid.UUID, db: DbSession) -> AnalysisRead:
    """The latest AI draft for this resume."""
    try:
        return _analysis_read(service.get_analysis(db, profile_id, resume_id))
    except service.NotFound as exc:
        raise _not_found(exc) from None


@router.get("/cv", response_model=CVDetailsRead, responses={404: {"description": "Not found"}})
def get_cv(profile_id: uuid.UUID, db: DbSession) -> CVDetailsRead:
    """The profile's confirmed CV details."""
    try:
        return _details_read(service.get_details(db, profile_id))
    except service.NotFound as exc:
        raise _not_found(exc) from None


@router.put("/cv", response_model=CVDetailsRead, responses={404: {"description": "Not found"}})
def save_cv(profile_id: uuid.UUID, body: ConfirmRequest, db: DbSession) -> CVDetailsRead:
    """Confirm (or edit) the profile's CV details. Replaces the saved details entirely
    with the reviewed data. Pass `source_analysis_id` when confirming an AI draft."""
    try:
        return _details_read(service.save_details(db, profile_id, body))
    except service.NotFound as exc:
        raise _not_found(exc) from None
