import os


def get_database_url() -> str:
    """Return DATABASE_URL from the environment (set by compose.yaml)."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url
