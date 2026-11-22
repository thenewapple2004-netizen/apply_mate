# Apply Mate

A browser extension and backend that autofill job applications from saved profiles and resumes. AI drafts the answers, and you review them before submitting.

## Layout

| Path | What it is |
| --- | --- |
| `extension/` | Browser extension (WXT + React + TypeScript) |
| `extension/features/` | `profiles`, `form-detector`, `autofill`, `answer-review` |
| `backend/` | Python FastAPI service |
| `backend/app/modules/` | `profiles`, `resumes`, `answers`, `applications`, `ai` |
| `backend/alembic/` | Database migrations |
| `docs/` | Project documentation |

## Backend and database (Docker)

The backend (FastAPI, Python 3.13) and PostgreSQL run in Docker. You only need Docker Desktop, not a local Python install. Run every command from the project root in PowerShell.

First-time setup: create your local `.env` and change the password in it.

```powershell
Copy-Item .env.example .env
```

| Task | Command |
| --- | --- |
| Build and start everything | `docker compose up --build -d` |
| Check status | `docker compose ps` |
| Stop (keeps database data) | `docker compose down` |
| Rebuild the backend after code changes | `docker compose up --build -d backend` |
| Follow backend logs | `docker compose logs -f backend` |
| Follow all logs | `docker compose logs -f` |
| Run the backend tests | `docker compose run --rm backend pytest` |

When it's running, http://127.0.0.1:8000/health returns `{"status":"ok","service":"applymate-backend"}`, and the interactive API docs are at http://127.0.0.1:8000/docs. Check it from PowerShell with:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Database data lives in the `pgdata` Docker volume and survives `docker compose down`. Running `docker compose down -v` **deletes it**.
