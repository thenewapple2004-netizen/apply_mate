import re
import unicodedata
import uuid

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.modules.answers.models import SavedAnswer


def question_key(question: str) -> str:
    """Normalize a question so small wording/formatting differences still match."""
    text = unicodedata.normalize("NFKD", question).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"\(.*?\)|\*", " ", text)  # drop "(optional)", required markers
    return re.sub(r"[^a-z0-9]+", " ", text).strip()[:300]


def list_answers(db: Session, profile_id: uuid.UUID) -> list[SavedAnswer]:
    return list(
        db.scalars(
            select(SavedAnswer)
            .where(SavedAnswer.profile_id == profile_id)
            .order_by(SavedAnswer.updated_at.desc())
        )
    )


def save_answers(db: Session, profile_id: uuid.UUID, items: list[tuple[str, str]]) -> int:
    """Insert or update answers by question. Returns how many were stored."""
    rows = {}
    for question, answer in items:
        key = question_key(question)
        if key and answer.strip():
            rows[key] = {"profile_id": profile_id, "question_key": key,
                         "question": question.strip()[:1000], "answer": answer.strip()}
    if not rows:
        return 0
    stmt = insert(SavedAnswer).values([{"id": uuid.uuid4(), **r} for r in rows.values()])
    stmt = stmt.on_conflict_do_update(
        index_elements=["profile_id", "question_key"],
        set_={"question": stmt.excluded.question, "answer": stmt.excluded.answer, "updated_at": func.now()},
    )
    db.execute(stmt)
    db.commit()
    return len(rows)
