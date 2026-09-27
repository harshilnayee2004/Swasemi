import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from auth import router as auth_router
from database import engine
from mqtt_ingest import start_mqtt, stop_mqtt
from realtime import get_sync_redis, redis_fanout_loop
from routers.admin import router as admin_router
from routers.trips import router as trips_router
from routers.vehicles import router as vehicles_router
from routers.ws import router as ws_router
from routers.sim import router as sim_router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from create_tables import init_db

    init_db()
    start_mqtt()
    fanout_task = asyncio.create_task(redis_fanout_loop())
    try:
        yield
    finally:
        fanout_task.cancel()
        try:
            await fanout_task
        except asyncio.CancelledError:
            pass
        import live_sim

        live_sim.shutdown()
        stop_mqtt()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv(
            "FRONTEND_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(vehicles_router)
app.include_router(trips_router)
app.include_router(sim_router)
app.include_router(ws_router)


@app.get("/health")
def health():
    dependencies = {"database": "ok", "redis": "ok"}
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:
        logging.exception("Health check database dependency failed")
        dependencies["database"] = "error"
    try:
        get_sync_redis().ping()
    except Exception:
        logging.exception("Health check Redis dependency failed")
        dependencies["redis"] = "error"
    if "error" in dependencies.values():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"status": "error", **dependencies},
        )
    return {"status": "ok", **dependencies}
