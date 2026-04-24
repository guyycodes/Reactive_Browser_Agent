# controllers/__init__.py

from fastapi import APIRouter
from .config_controller import router as config_router
from .upload_controller import router as upload_router
from .query_controller import router as query_router

# Create a single APIRouter to gather all sub-routers.
api_router = APIRouter()

# e.g., these become "/config" and "/upload" once you mount api_router elsewhere
api_router.include_router(config_router, prefix="/config", tags=["config"])
api_router.include_router(upload_router, prefix="/upload", tags=["upload"])
api_router.include_router(query_router, prefix="/models", tags=["query"])
