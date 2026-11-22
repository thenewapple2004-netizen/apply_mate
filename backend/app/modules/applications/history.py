"""Applied-jobs history and statistics (per profile)."""

import hashlib
import re
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.applications.models import JobApplication
from app.modules.applications.schemas import ApplicationIn, ApplicationStats

# Query parameters that identify a visit, not a job: ignored when comparing links.
_TRACKING = re.compile(r"^(utm_.*|gh_src|src|source|ref|referrer|fbclid|gclid|lever-.*|trk|mc_.*|_hs.*)$", re.I)


class ApplicationNotFound(Exception):
    pass


class InvalidTimezone(Exception):
    pass


def job_key(title: str, company: str, url: str) -> str:
    """Identifies a job: its link without tracking parameters (and without a trailing
    /apply, so the posting and its form match), or title and company if there is no link."""
    parsed = urlparse(url.strip()) if url else None
    if parsed and parsed.scheme in {"http", "https"} and parsed.netloc:
        path = re.sub(r"/apply$", "", parsed.path.rstrip("/"), flags=re.I).lower()
        query = sorted((k.lower(), v) for k, v in parse_qsl(parsed.query) if not _TRACKING.match(k))
        normalized = f"{parsed.netloc.lower()}{path}?{urlencode(query)}"
    else:
        normalized = f"{company.strip().lower()}|{title.strip().lower()}"
    return hashlib.sha256(normalized.encode()).hexdigest()


def record(db: Session, profile_id: uuid.UUID, data: ApplicationIn) -> tuple[JobApplication, bool]:
    """Save an application. Returns (row, created); an already-recorded job isn't counted twice."""
    key = job_key(data.title, data.company, data.url)

    def existing() -> JobApplication | None:
        return db.scalar(
            select(JobApplication).where(JobApplication.profile_id == profile_id, JobApplication.job_key == key)
        )

    row = existing()
    if row is not None:
        return row, False
    row = JobApplication(
        profile_id=profile_id,
        job_key=key,
        title=data.title,
        company=data.company,
        url=data.url,
        applied_at=data.applied_at or datetime.now(UTC),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:  # a concurrent request recorded it first
        db.rollback()
        row = existing()
        if row is None:
            raise
        return row, False
    db.refresh(row)
    return row, True


def list_recent(db: Session, profile_id: uuid.UUID, limit: int) -> list[JobApplication]:
    return list(
        db.scalars(
            select(JobApplication)
            .where(JobApplication.profile_id == profile_id)
            .order_by(JobApplication.applied_at.desc(), JobApplication.id)
            .limit(limit)
        )
    )


def remove(db: Session, profile_id: uuid.UUID, application_id: uuid.UUID) -> None:
    result = db.execute(
        delete(JobApplication).where(JobApplication.id == application_id, JobApplication.profile_id == profile_id)
    )
    if result.rowcount == 0:
        raise ApplicationNotFound
    db.commit()


def stats(db: Session, profile_id: uuid.UUID, timezone: str) -> ApplicationStats:
    """Counts for the applicant's own calendar: 'today' starts at their local midnight."""
    try:
        zone = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise InvalidTimezone from None
    midnight = datetime.now(zone).replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = midnight - timedelta(days=6)  # today and the six days before it
    month_start = midnight - timedelta(days=29)

    applied = JobApplication.applied_at
    total, today, week, month = db.execute(
        select(
            func.count(),
            func.count().filter(applied >= midnight),
            func.count().filter(applied >= week_start),
            func.count().filter(applied >= month_start),
        ).where(JobApplication.profile_id == profile_id)
    ).one()
    return ApplicationStats(total=total, today=today, last_7_days=week, last_30_days=month, timezone=timezone)
