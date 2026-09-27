from datetime import datetime, timezone

import compliance
import mqtt_ingest
from auth import hash_password
from models import Alert, Organization, Reading, RoutePoint, Trip, User, Vehicle


def seed_tenants(db):
    alpha = Organization(name="Alpha")
    beta = Organization(name="Beta")
    db.add_all([alpha, beta])
    db.flush()
    admin = User(email="admin@test.local", password_hash=hash_password("admin-pass"), role="super_admin")
    alpha_user = User(email="alpha@test.local", password_hash=hash_password("alpha-pass"), role="user", org_id=alpha.id)
    beta_user = User(email="beta@test.local", password_hash=hash_password("beta-pass"), role="user", org_id=beta.id)
    alpha_vehicle = Vehicle(name="Alpha truck", device_id="alpha-device", org_id=alpha.id)
    beta_vehicle = Vehicle(name="Beta van", device_id="beta-device", org_id=beta.id)
    db.add_all([admin, alpha_user, beta_user, alpha_vehicle, beta_vehicle])
    db.commit()
    return alpha, beta, alpha_user, beta_user, alpha_vehicle, beta_vehicle


def token(client, email, password):
    response = client.post("/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return response.json()["access_token"]


def test_login_success(db_session, client):
    seed_tenants(db_session)
    assert token(client, "alpha@test.local", "alpha-pass")


def test_login_failure(db_session, client):
    seed_tenants(db_session)
    response = client.post("/auth/login", json={"email": "alpha@test.local", "password": "wrong"})
    assert response.status_code == 401


def test_org_user_only_sees_own_vehicles(db_session, client):
    seed_tenants(db_session)
    response = client.get("/vehicles", headers={"Authorization": f"Bearer {token(client, 'alpha@test.local', 'alpha-pass')}"})
    assert response.status_code == 200
    assert [vehicle["name"] for vehicle in response.json()] == ["Alpha truck"]


def test_super_admin_sees_all_vehicles(db_session, client):
    seed_tenants(db_session)
    response = client.get("/vehicles", headers={"Authorization": f"Bearer {token(client, 'admin@test.local', 'admin-pass')}"})
    assert response.status_code == 200
    assert {vehicle["name"] for vehicle in response.json()} == {"Alpha truck", "Beta van"}


def test_start_trip_requires_saved_route(db_session, client):
    _, _, _, _, vehicle, _ = seed_tenants(db_session)
    response = client.post(
        f"/vehicles/{vehicle.id}/trips/start",
        headers={"Authorization": f"Bearer {token(client, 'alpha@test.local', 'alpha-pass')}"},
    )
    assert response.status_code == 400
    assert "planned route" in response.json()["detail"]


def test_telemetry_is_dropped_without_active_trip(db_session):
    seed_tenants(db_session)
    reading = mqtt_ingest.ingest_telemetry({"device_id": "alpha-device", "latitude": 23.0, "longitude": 72.0})
    assert reading is None
    assert db_session.query(Reading).count() == 0


def test_telemetry_is_persisted_for_active_trip(db_session):
    alpha, _, _, _, vehicle, _ = seed_tenants(db_session)
    db_session.add(Trip(vehicle_id=vehicle.id, org_id=alpha.id, status="active"))
    db_session.commit()
    reading = mqtt_ingest.ingest_telemetry({"device_id": "alpha-device", "latitude": 23.0, "longitude": 72.0})
    assert reading is not None
    assert db_session.query(Reading).count() == 1


def test_route_deviation_creates_alert(db_session, monkeypatch):
    alpha, _, _, _, vehicle, _ = seed_tenants(db_session)
    trip = Trip(vehicle_id=vehicle.id, org_id=alpha.id, status="active")
    db_session.add(trip)
    db_session.flush()
    db_session.add_all([
        RoutePoint(trip_id=trip.id, seq=0, latitude=23.0, longitude=72.0),
        RoutePoint(trip_id=trip.id, seq=1, latitude=23.0, longitude=72.001),
    ])
    db_session.commit()
    monkeypatch.setattr(compliance, "DEVIATION_METERS", 10)
    monkeypatch.setattr(compliance, "send_email", lambda *args: True)
    alert = compliance.evaluate_route_compliance(db_session, trip, vehicle, 23.01, 72.0)
    assert alert is not None
    assert db_session.query(Alert).count() == 1
