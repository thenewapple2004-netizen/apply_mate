import os
from pathlib import Path


def get_database_url() -> str:
    """Return DATABASE_URL from the environment (set by compose.yaml)."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


def get_resume_storage_dir() -> Path:
    """Directory for uploaded resume files: a private Docker volume, never served publicly."""
    return Path(os.environ.get("RESUME_STORAGE_DIR", "/data/resumes"))
