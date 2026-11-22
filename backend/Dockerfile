# syntax=docker/dockerfile:1
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install dependencies (including test tools) before copying the code, so code
# changes don't re-download packages. The empty app/ stub lets the editable
# install succeed; the real package is copied over it below. pip's download
# cache is kept between builds, so changing pyproject.toml only fetches what's new.
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    mkdir app && touch app/__init__.py && pip install -e ".[dev]"

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY tests ./tests

# Run as a non-root user.
RUN useradd --create-home --uid 1000 appuser && chown appuser:appuser /app
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
