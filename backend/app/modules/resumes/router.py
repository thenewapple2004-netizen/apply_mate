import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db.session import get_db
from app.modules.resumes import service
from app.modules.resumes.extraction import ResumeFileError, UnsupportedFile
from app.modules.resumes.schemas import ResumeDetail, ResumeRead

router = APIRouter(prefix="/api/v1/profiles/{profile_id}/resumes", tags=["resumes"])

DbSession = Annotated[Session, Depends(get_db)]
NOT_FOUND = {404: {"description": "Profile or resume not found"}}
_CHUNK = 1024 * 1024


def _not_found(exc: Exception) -> HTTPException:
    what = "Profile" if isinstance(exc, service.ProfileNotFound) else "Resume"
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


async def _read_limited(upload: UploadFile) -> bytes:
    """Read the upload, stopping as soon as it exceeds the size limit."""
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(_CHUNK):
        total += len(chunk)
        if total > service.MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="The file is larger than the 10 MB limit.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.get("", response_model=list[ResumeRead], responses=NOT_FOUND)
def list_resumes(profile_id: uuid.UUID, db: DbSession) -> list[ResumeRead]:
    try:
        return [ResumeRead.from_model(r) for r in service.list_resumes(db, profile_id)]
    except service.ProfileNotFound as exc:
        raise _not_found(exc) from None


@router.post(
    "",
    response_model=ResumeRead,
    status_code=status.HTTP_201_CREATED,
    responses={
        **NOT_FOUND,
        413: {"description": "File larger than 10 MB"},
        415: {"description": "Not a PDF or DOCX file"},
        422: {"description": "Empty, damaged or password-protected file"},
    },
)
async def upload_resume(
    profile_id: uuid.UUID,
    db: DbSession,
    file: Annotated[UploadFile, File(description="A PDF or DOCX resume, up to 10 MB")],
) -> ResumeRead:
    data = await _read_limited(file)
    try:
        # Parsing is CPU-bound and synchronous; run it off the event loop.
        resume = await run_in_threadpool(
            service.create_resume, db, profile_id, file.filename or "", data
        )
    except service.ProfileNotFound as exc:
        raise _not_found(exc) from None
    except ResumeFileError as exc:
        code = (
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE
            if isinstance(exc, UnsupportedFile)
            else status.HTTP_422_UNPROCESSABLE_CONTENT
        )
        raise HTTPException(status_code=code, detail=exc.message) from None
    return ResumeRead.from_model(resume)


@router.get("/{resume_id}", response_model=ResumeDetail, responses=NOT_FOUND)
def get_resume(profile_id: uuid.UUID, resume_id: uuid.UUID, db: DbSession) -> ResumeDetail:
    """Resume metadata plus its extracted text."""
    try:
        return ResumeDetail.from_model(service.get_resume(db, profile_id, resume_id))
    except (service.ProfileNotFound, service.ResumeNotFound) as exc:
        raise _not_found(exc) from None


@router.put("/{resume_id}/primary", response_model=ResumeRead, responses=NOT_FOUND)
def make_primary(profile_id: uuid.UUID, resume_id: uuid.UUID, db: DbSession) -> ResumeRead:
    """Make this the profile's primary resume (any previous primary is unset)."""
    try:
        return ResumeRead.from_model(service.set_primary(db, profile_id, resume_id, True))
    except (service.ProfileNotFound, service.ResumeNotFound) as exc:
        raise _not_found(exc) from None


@router.delete("/{resume_id}/primary", response_model=ResumeRead, responses=NOT_FOUND)
def unset_primary(profile_id: uuid.UUID, resume_id: uuid.UUID, db: DbSession) -> ResumeRead:
    """Stop using this resume as the primary one (the profile then has none)."""
    try:
        return ResumeRead.from_model(service.set_primary(db, profile_id, resume_id, False))
    except (service.ProfileNotFound, service.ResumeNotFound) as exc:
        raise _not_found(exc) from None


@router.delete("/{resume_id}", status_code=status.HTTP_204_NO_CONTENT, responses=NOT_FOUND)
def delete_resume(profile_id: uuid.UUID, resume_id: uuid.UUID, db: DbSession) -> Response:
    try:
        service.delete_resume(db, profile_id, resume_id)
    except (service.ProfileNotFound, service.ResumeNotFound) as exc:
        raise _not_found(exc) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
