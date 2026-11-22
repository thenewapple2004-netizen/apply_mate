"""Resume files on disk: <storage dir>/<profile id>/<resume id>.<ext>.

Paths are built only from UUIDs and a fixed extension, never from the uploaded
filename, so a crafted filename can't escape the storage directory.
"""

import logging
import os
import shutil
import uuid
from pathlib import Path

from app.core.config import get_resume_storage_dir

logger = logging.getLogger(__name__)


def storage_key(profile_id: uuid.UUID, resume_id: uuid.UUID, file_type: str) -> str:
    return f"{profile_id}/{resume_id}.{file_type}"


def _path(key: str) -> Path:
    root = get_resume_storage_dir().resolve()
    path = (root / key).resolve()
    if root not in path.parents:
        raise ValueError("storage key outside the storage directory")
    return path


def save(key: str, data: bytes) -> None:
    path = _path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)  # atomic: a reader never sees a half-written file


def delete(key: str) -> None:
    try:
        _path(key).unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not delete resume file %s", key)


def delete_profile_files(profile_id: uuid.UUID) -> None:
    folder = _path(f"{profile_id}/.keep").parent
    shutil.rmtree(folder, ignore_errors=True)
