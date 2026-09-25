import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import redis.asyncio as redis_async
from fastapi import WebSocket
from redis import Redis
from sqlalchemy.orm import Session

from models import Alert, Organization, Reading, Trip, User, Vehicle

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_CHANNEL = os.getenv("REDIS_CHANNEL", "fleet:telemetry")

_sync_redis: Redis | None = None


def get_sync_redis() -> Redis:
    global _sync_redis
    if _sync_redis is None:
        _sync_redis = Redis.from_url(REDIS_URL, decode_responses=True)
    return _sync_redis


def publish_telemetry(payload: dict) -> None:
    try:
        get_sync_redis().publish(REDIS_CHANNEL, json.dumps(payload, default=str))
    except Exception:
        logger.exception("Redis publish failed")


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def reading_payload(
    reading: Reading,
    vehicle: Vehicle,
    org_name: str | None,
) -> dict:
    return {
        "type": "reading",
        "vehicle_id": vehicle.id,
        "device_id": vehicle.device_id,
        "name": vehicle.name,
        "org_id": vehicle.org_id,
        "org_name": org_name,
        "trip_id": reading.trip_id,
        "timestamp": _iso(reading.timestamp),
        "last_seen": _iso(reading.timestamp),
        "temperature": reading.temperature,
        "humidity": reading.humidity,
        "dew_point": reading.dew_point,
        "elevation": reading.elevation,
        "latitude": reading.latitude,
        "longitude": reading.longitude,
    }


def alert_payload(alert: Alert, vehicle: Vehicle, org_name: str | None) -> dict:
    return {
        "type": "alert",
        "id": alert.id,
        "vehicle_id": vehicle.id,
        "device_id": vehicle.device_id,
        "name": vehicle.name,
        "org_id": vehicle.org_id,
        "org_name": org_name,
        "trip_id": alert.trip_id,
        "alert_type": alert.type,
        "message": alert.message,
        "latitude": alert.latitude,
        "longitude": alert.longitude,
        "created_at": _iso(alert.created_at),
        "emailed_at": _iso(alert.emailed_at),
    }


def build_snapshot(db: Session, user: User) -> dict:
    query = (
        db.query(Vehicle, Organization.name)
        .join(Organization, Vehicle.org_id == Organization.id)
        .order_by(Vehicle.id)
    )
    if user.role == "user":
        query = query.filter(Vehicle.org_id == user.org_id)

    rows = query.all()
    vehicle_ids = [vehicle.id for vehicle, _ in rows]

    latest_by_vehicle: dict[int, Reading] = {}
    active_trip_by_vehicle: dict[int, int] = {}
    if vehicle_ids:
        latest_rows = (
            db.query(Reading)
            .distinct(Reading.vehicle_id)
            .filter(Reading.vehicle_id.in_(vehicle_ids))
            .order_by(Reading.vehicle_id, Reading.timestamp.desc())
            .all()
        )
        latest_by_vehicle = {row.vehicle_id: row for row in latest_rows}
        active_trips = (
            db.query(Trip)
            .filter(Trip.vehicle_id.in_(vehicle_ids), Trip.status == "active")
            .all()
        )
        active_trip_by_vehicle = {trip.vehicle_id: trip.id for trip in active_trips}

    vehicles = []
    for vehicle, org_name in rows:
        reading = latest_by_vehicle.get(vehicle.id)
        vehicles.append(
            {
                "vehicle_id": vehicle.id,
                "device_id": vehicle.device_id,
                "name": vehicle.name,
                "org_id": vehicle.org_id,
                "org_name": org_name,
                "trip_id": active_trip_by_vehicle.get(vehicle.id),
                "last_seen": _iso(reading.timestamp) if reading else None,
                "temperature": reading.temperature if reading else None,
                "humidity": reading.humidity if reading else None,
                "dew_point": reading.dew_point if reading else None,
                "elevation": reading.elevation if reading else None,
                "latitude": reading.latitude if reading else None,
                "longitude": reading.longitude if reading else None,
            }
        )
    return {"type": "snapshot", "vehicles": vehicles}


class ClientUser:
    def __init__(self, id: int, role: str, org_id: int | None):
        self.id = id
        self.role = role
        self.org_id = org_id


def user_can_see_org(user: User | ClientUser, org_id: int) -> bool:
    if user.role == "super_admin":
        return True
    return user.role == "user" and user.org_id == org_id


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: list[tuple[WebSocket, ClientUser]] = []

    async def connect(self, websocket: WebSocket, user: User) -> None:
        self._clients.append(
            (websocket, ClientUser(id=user.id, role=user.role, org_id=user.org_id))
        )

    def disconnect(self, websocket: WebSocket) -> None:
        self._clients = [
            (client, user) for client, user in self._clients if client is not websocket
        ]

    async def broadcast(self, payload: dict) -> None:
        org_id = payload.get("org_id")
        stale: list[WebSocket] = []
        for websocket, user in self._clients:
            if org_id is not None and not user_can_see_org(user, org_id):
                continue
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(websocket)


manager = ConnectionManager()


async def redis_fanout_loop() -> None:
    while True:
        client = None
        pubsub = None
        try:
            client = redis_async.from_url(REDIS_URL, decode_responses=True)
            pubsub = client.pubsub()
            await pubsub.subscribe(REDIS_CHANNEL)
            logger.info("Redis subscribed to %s", REDIS_CHANNEL)
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                data = message.get("data")
                if not data:
                    continue
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    logger.warning("Invalid Redis payload: %s", data)
                    continue
                await manager.broadcast(payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Redis fan-out disconnected; retrying")
            await asyncio.sleep(1)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass
            if client is not None:
                try:
                    await client.aclose()
                except Exception:
                    pass
