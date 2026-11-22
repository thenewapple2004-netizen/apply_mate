from fastapi import FastAPI

from app.api.health import router as health_router
from app.modules.profiles.router import router as profiles_router

app = FastAPI(title="ApplyMate Backend", version="0.1.0")

app.include_router(health_router)
app.include_router(profiles_router)
