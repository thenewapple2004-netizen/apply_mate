"""Cache of AI-prepared answers, so repeated questions never wait for the AI.

An entry is only reused when everything the AI based it on is unchanged:
- the question text, field type and options
- the applicant's profile and confirmed CV (a version stamp changes on any edit)
- for job-specific questions (long answers, "why us"...), the job description
Entries unused for 30 days are removed.
"""

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.modules.answers import service as saved
from app.modules.answers.models import AnswerCache
from app.modules.applications.schemas import Answer, FormField, Job
from app.modules.cv.models import CVDetails
from app.modules.preferences.models import ApplicantPreferences
from app.modules.profiles.models import Profile

MAX_AGE = timedelta(days=30)
_JOB_SPECIFIC = re.compile(
    r"\b(why|cover letter|motivation|interest(ed)? in|about yourself|anything else|"
    r"additional information|how did you hear|relevant experience|describe|tell us)\b",
    re.I,
)


def context_version(
    profile: Profile, details: CVDetails | None, prefs: ApplicantPreferences | None = None
) -> str:
    """Changes whenever the profile, confirmed CV or preferences are edited, which
    makes every cached answer (and any answers prepared in the extension) out of date."""
    stamp = [
        profile.updated_at.isoformat() if profile.updated_at else "",
        details.updated_at.isoformat() if details else "",
        prefs.updated_at.isoformat() if prefs else "",
    ]
    return hashlib.sha256(json.dumps(stamp).encode()).hexdigest()[:16]


def job_hash(job: Job) -> str:
    text = f"{job.title}|{job.company}|{job.description[:3000]}"
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def is_job_specific(field: FormField) -> bool:
    return field.type == "textarea" or bool(_JOB_SPECIFIC.search(field.label))


def cache_key(field: FormField, version: str, job: Job) -> str:
    parts = [
        saved.question_key(field.label),
        field.type,
        sorted(o.value for o in field.options),
        version,
        job_hash(job) if is_job_specific(field) else "",
    ]
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()


def lookup(db: Session, profile_id: uuid.UUID, keys: list[str]) -> dict[str, dict]:
    """Cached payloads by key; marks them as used."""
    if not keys:
        return {}
    rows = db.scalars(
        select(AnswerCache).where(AnswerCache.profile_id == profile_id, AnswerCache.cache_key.in_(keys))
    ).all()
    if rows:
        db.execute(
            update(AnswerCache)
            .where(AnswerCache.id.in_([r.id for r in rows]))
            .values(hits=AnswerCache.hits + 1, last_used_at=datetime.now(UTC))
        )
        db.commit()
    return {r.cache_key: r.payload for r in rows}


def store(db: Session, profile_id: uuid.UUID, items: list[tuple[str, Answer]]) -> None:
    """Remember AI results (answers, or 'needs you' results with their suggestions)."""
    rows = [
        {
            "id": uuid.uuid4(),
            "profile_id": profile_id,
            "cache_key": key,
            "payload": {
                "value": a.value,
                "values": a.values,
                "note": a.note,
                "suggestions": [s.model_dump() for s in a.suggestions],
                "source": a.source,
            },
        }
        for key, a in items
    ]
    if rows:
        stmt = insert(AnswerCache).values(rows)
        db.execute(
            stmt.on_conflict_do_update(
                index_elements=["profile_id", "cache_key"],
                set_={"payload": stmt.excluded.payload, "last_used_at": datetime.now(UTC)},
            )
        )
    db.execute(delete(AnswerCache).where(AnswerCache.profile_id == profile_id, AnswerCache.last_used_at < datetime.now(UTC) - MAX_AGE))
    db.commit()


def from_payload(field_id: str, payload: dict) -> Answer:
    return Answer(
        field_id=field_id,
        value=payload.get("value"),
        values=payload.get("values") or [],
        note=payload.get("note"),
        suggestions=payload.get("suggestions") or [],
        source=payload.get("source") or "ai",
        cached=True,
    )
