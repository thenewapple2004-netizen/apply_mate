from fastapi import FastAPI

from app.api.health import router as health_router
from app.modules.profiles.router import router as profiles_router
from app.modules.resumes.router import router as resumes_router

app = FastAPI(title="ApplyMate Backend", version="0.1.0")

app.include_router(health_router)
app.include_router(profiles_router)
app.include_router(resumes_router)
