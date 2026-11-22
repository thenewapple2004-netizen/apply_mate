# Apply Mate

Shown to users as **Job Fellow** (working name; the repository and package names stay `apply_mate` until the brand is confirmed).

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

## CV analysis (Gemini)

ApplyMate can read a resume's extracted text with Google Gemini and turn it into structured, editable CV details: summary, skills, technologies, work experience, education, projects and certifications.

### Setup

1. Get a Gemini API key at https://aistudio.google.com/apikey.
2. In `.env`, set `GEMINI_API_KEY=...`. Optionally set `GEMINI_MODEL` (default `gemini-2.5-flash`).
3. Recreate the backend so it reads the new values. `restart` doesn't reload `.env`:

```powershell
docker compose up -d
```

The key stays in the backend. The extension never sees it. Without a key, analysis returns a clear "isn't configured" message and everything else keeps working.

### Onboarding (in the popup)

Everything happens in the extension popup (shown as **Job Fellow**). No extra tabs open.

1. **Profile:** choose a profile, or **+ New profile** and enter a name.
2. **Resume:** upload a PDF or DOCX. It becomes the profile's resume.
3. **Details:** choose **Suggest with AI** or **Fill in manually**. The AI option explains first that the resume's **text** (not the file) goes to Google Gemini; the backend also refuses analysis without `consent: true`. If AI isn't available (no key, quota, outage), the popup says why and you fill in the details yourself.
4. **Review:** one form shows only what's missing or unconfirmed: contact fields the profile doesn't have yet, and CV items that aren't saved yet. AI suggestions are a draft. Facts not found in the resume text are listed under *Please double-check*. Correct or remove anything, then **Save details**.

Reopening the popup shows the selected profile and its resume directly. Secondary actions:
- **Edit details** shows the same form with all fields.
- **Preview resume** shows the resume's text.
- **Replace resume** uploads a new file; saved details are kept.
- **Update from resume** reviews only the new items found in the current resume.

Saving a review only fills empty contact fields and adds new items. It never overwrites details you already confirmed.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/profiles/{profile_id}/onboarding` | Current step (`resume`, `review` or `complete`), current resume, saved details, and the review form when needed |
| `POST /api/v1/profiles/{profile_id}/onboarding/confirm` | Save reviewed details (`contact`, `cv`, `source_analysis_id`) by filling gaps and adding new items |

Optional settings: `GEMINI_TIMEOUT_SECONDS` (default 60) and `GEMINI_MAX_ATTEMPTS` (default 3; covers timeouts, server errors and unreadable output). Quota/rate-limit errors (HTTP 429) are not retried; the user sees a "quota reached" message.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/profiles/{profile_id}/resumes/{resume_id}/analysis` | Analyze with Gemini (body `{"consent": true}`) and store a draft |
| `GET /api/v1/profiles/{profile_id}/resumes/{resume_id}/analysis` | The latest draft for that resume |
| `GET /api/v1/profiles/{profile_id}/cv` | Confirmed CV details |
| `PUT /api/v1/profiles/{profile_id}/cv` | Save (confirm or edit) CV details; pass `source_analysis_id` when confirming a draft |

AI errors: 429 quota, 502 unreadable response or rejected request (bad key or model), 503 not configured or unavailable, 504 timeout.

**Storage:** drafts are in `cv_analyses` (one per resume; they reference the resume instead of copying its text). Confirmed details are in `cv_details` plus `cv_work_experiences`, `cv_educations`, `cv_projects` and `cv_certifications`, keyed by profile. Deleting a profile deletes all of it. Deleting a resume removes its draft but keeps the confirmed details. Logs never contain resume text, AI output or the API key.

## Applying to a job

Once a profile is set up, the popup shows the workflow **Profile → Job → Answers → Review → Fill**:

1. **Job:** on a job posting, click **Detect job on this page**. Job Fellow reads the posting (schema.org `JobPosting` data when the site has it, otherwise the page text) and shows the title, company and description for you to confirm or edit. The confirmed job is remembered when you move on to the application form.
2. **Answers:** on the application form, click **Prepare answers for this page**. Job Fellow finds the visible questions (text fields, text areas, dropdowns, radio buttons, checkboxes) and prepares answers:
   - contact fields straight from the profile;
   - answers you approved before for the same question;
   - Gemini for the rest, using only your profile, confirmed CV and the job description. Choices must match the page's options. Anything unsupported by your data is left blank ("Needs you").
3. **Review:** edit or clear any answer.
4. **Fill:** fills the approved answers on the page. Consent/declaration checkboxes and file uploads are left to you, and **Job Fellow never clicks Next, Apply or Submit**. Approved answers are saved for next time.

Permissions: `activeTab` + `scripting` (the page is read only when you open Job Fellow on it) and `storage`.

### Preferences

**Profile & resume → Preferences** holds what you want and are allowed to do. Everything is optional and stored per profile in PostgreSQL: salary expectation, notice period, preferred locations, work arrangement (remote / hybrid / on-site), the countries you're authorized to work in, whether you need visa sponsorship, and your reason for changing jobs.

- Questions about these are answered **from your preferences, not by the AI**. A notice period, locations, arrangement or reason for changing jobs is filled directly.
- **Salary, work authorization and sponsorship are only proposals.** They appear marked **Approve** and are filled only after you tick approve for each one. They are never sent to the AI, cached, or saved for reuse. Consent and legal declarations always stay with you.
- If a preference isn't set, the question stays in the review with a note ("…isn't in your Preferences yet") and nothing is invented. The AI may still suggest options to pick from for non-sensitive ones (e.g. notice period), but never answers for you. Work authorization only answers "Yes" for a country you listed; for any other country it asks you.
- Non-sensitive preferences (notice period, locations, arrangement, reason for changing jobs) are given to the AI as background for other answers. Salary, authorization and sponsorship are not.
- **Changing preferences invalidates everything based on the old ones:** cached AI answers (the preferences are part of the cache key) and answers already prepared in the popup, which are discarded the next time they'd be used.

| Endpoint | Purpose |
| --- | --- |
| `GET` / `PUT /api/v1/profiles/{profile_id}/preferences` | Read / replace the preferences (empty or omitted fields mean "not set") |
| `GET /api/v1/profiles/{profile_id}/applications/context` | Version stamp of profile, CV and preferences, used to detect outdated prepared answers |

### Tracking applications

After you submit an application on the website, click **✓ Mark as applied** in the popup (it becomes the main button once the form is filled). Job Fellow can't see whether a form was really sent, so counting is always your click. It saves the job (title, company, link, date) to your history and **clears the current job and its prepared answers**, so the next job starts fresh. **Discard** forgets a job without counting it.

The top of the popup shows jobs applied in total, today and in the last 7 days (counted in your own time zone); expand it for the recent history, each with a link, and ✕ to remove a mistake. The same job counts once, even from a different link to it (tracking parameters such as `utm_*` and a trailing `/apply` are ignored). History is kept per profile in PostgreSQL.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/profiles/{profile_id}/applications` | Record an application (`title`, `company`, `url`); 201 new, 200 if already recorded |
| `GET /api/v1/profiles/{profile_id}/applications?limit=` | Recent applications, newest first |
| `GET /api/v1/profiles/{profile_id}/applications/stats?tz=` | `total`, `today`, `last_7_days`, `last_30_days` in the given IANA time zone |
| `DELETE /api/v1/profiles/{profile_id}/applications/{id}` | Remove an entry |

### Speed and the answer cache

- **Answer cache:** AI answers are remembered in PostgreSQL (`answer_cache`, per profile). A repeated question, on any site, is answered instantly without calling Gemini; the review shows "N reused instantly". An entry is reused only if the question, its options, your profile and confirmed CV are unchanged (editing either clears it), and, for job-specific questions such as cover letters, the job description is the same. Entries unused for 30 days are removed. **Regenerate** in the review asks the AI again.
- **Saved answers** (answers you approved) still take priority over the cache. Consent, personal and salary questions are never cached or saved.
- **Faster AI calls:** one reused connection, thinking switched off (`GEMINI_THINKING=on` to re-enable), compact prompts, and one AI call per form. If the main model's daily quota runs out or it is overloaded, the call moves to `GEMINI_FALLBACK_MODEL` (default `gemini-2.5-flash`; `none` disables it). Free-tier quotas are per model per day, so a fast current model as `GEMINI_MODEL` (e.g. `gemini-2.5-flash`) avoids the failed first attempt.
- Page scanning and filling poll for custom dropdowns instead of waiting fixed times.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/profiles/{profile_id}/applications/answers` | Prepare answers for detected fields (`job`, `fields`) |
| `GET` / `PUT /api/v1/profiles/{profile_id}/answers` | List / save approved answers |

### Demo job application

The backend serves a demo posting and application form at **http://127.0.0.1:8000/demo/** (nothing is sent anywhere; Submit only shows a message).

## Extension

```powershell
cd extension
npm.cmd install
npm.cmd run build
```

Load `extension/.output/chrome-mv3` in Chrome with **Load unpacked** at `chrome://extensions` (Developer mode on), or click the reload icon on the ApplyMate card after rebuilding. The extension asks only for `storage` and access to `http://127.0.0.1:8000` / `http://localhost:8000`.
