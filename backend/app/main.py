from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.health import router as health_router
from app.modules.applications.router import router as applications_router
from app.modules.cv.router import router as cv_router
from app.modules.onboarding.router import router as onboarding_router
from app.modules.profiles.router import router as profiles_router
from app.modules.resumes.router import router as resumes_router

app = FastAPI(title="ApplyMate Backend", version="0.1.0")

app.include_router(health_router)
app.include_router(profiles_router)
app.include_router(resumes_router)
app.include_router(cv_router)
app.include_router(onboarding_router)
app.include_router(applications_router)

# Local demo job posting + application form for testing the extension:
# http://127.0.0.1:8000/demo/
DEMO_DIR = Path(__file__).resolve().parent.parent / "demo"
if DEMO_DIR.is_dir():
    app.mount("/demo", StaticFiles(directory=DEMO_DIR, html=True), name="demo")
