import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db.session import get_engine

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "applymate-backend"}


@router.get("/health/db", responses={503: {"description": "Database unavailable"}})
def health_db() -> JSONResponse:
    try:
        with get_engine().connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:
        # Details (which may include the host or user) go to the server log only.
        logger.exception("Database health check failed")
        return JSONResponse(status_code=503, content={"status": "error", "database": "unavailable"})
    return JSONResponse(status_code=200, content={"status": "ok", "database": "ok"})
