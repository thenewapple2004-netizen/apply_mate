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

| Restart without losing data | `docker compose restart` |
| Run only the database tests | `docker compose run --rm backend pytest tests/test_db.py` |
| Open a SQL shell | `docker compose exec db psql -U apply_mate -d apply_mate` |

When it's running, the interactive API docs are at http://127.0.0.1:8000/docs. Health checks:

| Endpoint | Healthy response |
| --- | --- |
| `GET /health` | `{"status":"ok","service":"applymate-backend"}` |
| `GET /health/db` | `{"status":"ok","database":"ok"}` (HTTP 503 with `"database":"unavailable"` if the database can't be reached) |

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/health/db
```

Database data lives in the `pgdata` Docker volume and survives restarts and `docker compose down`. Running `docker compose down -v` **deletes it**.

### Database configuration

The backend gets `DATABASE_URL` from `compose.yaml`, built from the `POSTGRES_*` values in `.env`, with `db` (the Compose service name) as the host. The SQLAlchemy base class is in `backend/app/db/base.py`, and the engine and per-request session (`get_db`) are in `backend/app/db/session.py`. If your password contains `@`, `:`, `/` or `%`, URL-encode it in `.env`.

### Migrations (Alembic)

Alembic runs inside the backend container and reads `DATABASE_URL` from the environment. Migration files live in `backend/alembic/versions/`.

| Task | Command |
| --- | --- |
| Show the current revision | `docker compose exec backend alembic current` |
| Show migration history | `docker compose exec backend alembic history` |
| Apply all pending migrations | `docker compose exec backend alembic upgrade head` |
| Roll back one migration | `docker compose exec backend alembic downgrade -1` |
| Create a migration from model changes | see below |

New models must be imported in `backend/alembic/env.py` so autogenerate can see them. To generate a migration and save the file to your machine (not just inside the container), mount the versions folder:

```powershell
docker compose run --rm -v ${PWD}/backend/alembic/versions:/app/alembic/versions backend alembic revision --autogenerate -m "describe the change"
```

Review the generated file, then rebuild (`docker compose up --build -d backend`) and run `alembic upgrade head`.

Migrations are never applied automatically when the app starts. After pulling changes that add a migration, run:

```powershell
docker compose up --build -d
docker compose exec backend alembic upgrade head
```

### Tests

`docker compose run --rm backend pytest` runs all backend tests. Tests that need the database use a separate `apply_mate_test` database, which is created and migrated automatically and emptied before each test, so they never touch your real profiles.

## Profiles

ApplyMate stores multiple applicant profiles. In the popup you can create, edit and delete profiles and choose which one is active. Nothing is selected until you choose a profile. The popup remembers the active profile's ID (only the ID, in `chrome.storage.local`) and restores it when reopened, and forgets it if that profile is deleted.

Profile separation keeps each applicant's data apart. It is **not** authentication: anyone who can reach the local backend can read and change every profile. The backend is published on `127.0.0.1` only.

| Endpoint | Purpose | Success |
| --- | --- | --- |
| `GET /api/v1/profiles` | List profiles (oldest first) | 200 |
| `POST /api/v1/profiles` | Create a profile | 201 |
| `GET /api/v1/profiles/{id}` | Get one profile | 200 |
| `PATCH /api/v1/profiles/{id}` | Update the fields sent; send `null` or `""` to clear an optional field | 200 |
| `DELETE /api/v1/profiles/{id}` | Delete a profile | 204 |

`full_name` is required (up to 200 characters). `email`, `phone`, `location` and `linkedin_url` are optional, and `linkedin_url` must be a `linkedin.com` address. Errors: 404 for an unknown ID, 422 for invalid input or a malformed ID.

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/v1/profiles
Invoke-RestMethod http://127.0.0.1:8000/api/v1/profiles -Method Post -ContentType application/json -Body '{"full_name":"Arslan","email":"arslan@example.com"}'
```

## Resumes

Each profile can have several resumes (PDF or DOCX, up to 10 MB each) and at most one primary resume. In the popup, select a profile, then use **+ Upload resume**. You can preview the extracted text, make a resume primary (or unset it), and delete it after confirming.

- **Validation:** the file's contents are checked, not just its extension. Empty, damaged, password-protected, legacy `.doc`, mislabeled and unsupported files are rejected with a clear message (HTTP 413 for size, 415 for type, 422 for unreadable).
- **Text extraction:** `pypdf` for PDF, and the document XML (parsed with `defusedxml`) for DOCX. There is no OCR: a scanned, image-only PDF is stored but marked "No readable text".
- **Storage:** files are kept in the private `resume_files` Docker volume at `/data/resumes/<profile id>/<resume id>.<ext>`, readable only by the backend user. Their metadata and extracted text are in the `resumes` table. Deleting a resume or a profile also deletes the files.
- **Privacy:** logs contain only IDs, file types and sizes, never filenames or resume text.

| Endpoint | Purpose | Success |
| --- | --- | --- |
| `GET /api/v1/profiles/{profile_id}/resumes` | List resumes (metadata only) | 200 |
| `POST /api/v1/profiles/{profile_id}/resumes` | Upload (multipart field `file`) | 201 |
| `GET /api/v1/profiles/{profile_id}/resumes/{resume_id}` | Metadata plus extracted text | 200 |
| `PUT /api/v1/profiles/{profile_id}/resumes/{resume_id}/primary` | Make primary (unsets the previous one) | 200 |
| `DELETE /api/v1/profiles/{profile_id}/resumes/{resume_id}/primary` | Unset primary | 200 |
| `DELETE /api/v1/profiles/{profile_id}/resumes/{resume_id}` | Delete resume and file | 204 |

Every request is checked against the profile in the URL: a resume can't be read or changed through another profile's ID (404). This keeps applicants' data apart but is **not** security against other local users; add authentication before any deployment beyond your own machine.

Sample files for manual testing (a PDF, a DOCX, a scanned PDF, a password-protected PDF and some invalid files):

```powershell
docker compose run --rm --no-deps --user root -v "${PWD}/samples:/out" backend python -m tests.samples /out
```

This writes them to a `samples/` folder in the project root; delete it when you're done.

## Extension

```powershell
cd extension
npm.cmd install
npm.cmd run build
```

Load `extension/.output/chrome-mv3` in Chrome with **Load unpacked** at `chrome://extensions` (Developer mode on), or click the reload icon on the ApplyMate card after rebuilding. The extension asks only for `storage` and access to `http://127.0.0.1:8000` / `http://localhost:8000`.
