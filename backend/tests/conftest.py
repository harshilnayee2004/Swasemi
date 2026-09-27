import os
import sys
from pathlib import Path

os.environ["ENVIRONMENT"] = "development"
os.environ["DATABASE_URL"] = "sqlite+pysqlite://"

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import mqtt_ingest
from database import Base, get_db
from main import app
import models  # noqa: F401


@pytest.fixture()
def db_session(monkeypatch):
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = session_local()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(mqtt_ingest, "SessionLocal", session_local)
    db = session_local()
    try:
        yield db
    finally:
        db.close()
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client():
    return TestClient(app)
