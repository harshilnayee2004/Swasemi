import json
import logging
import os
import uuid
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from sqlalchemy.orm import Session

from database import SessionLocal
from compliance import evaluate_route_compliance
from models import Organization, Reading, Trip, Vehicle
from realtime import publish_telemetry, reading_payload

logger = logging.getLogger(__name__)

MQTT_HOST = os.getenv("MQTT_HOST", "broker.emqx.io")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "swasemi/fleet/+/readings")
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")

_mqtt_client: mqtt.Client | None = None


def _parse_timestamp(value) -> datetime:
    if value is None or value == "":
        return datetime.now(timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    text = str(value).replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _device_id_from_topic(topic: str) -> str | None:
    parts = topic.split("/")
    # swasemi/fleet/{device_id}/readings
    if len(parts) >= 3:
        return parts[2]
    return None


def ingest_telemetry(payload: dict, topic: str = "") -> Reading | None:
    device_id = payload.get("device_id") or _device_id_from_topic(topic)
    if not device_id:
        logger.warning("Telemetry missing device_id: %s", payload)
        return None

    try:
        latitude = float(payload["latitude"])
        longitude = float(payload["longitude"])
    except (KeyError, TypeError, ValueError):
        logger.warning("Telemetry missing lat/lng: %s", payload)
        return None

    def optional_float(key: str) -> float | None:
        value = payload.get(key)
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    db: Session = SessionLocal()
    try:
        vehicle = db.query(Vehicle).filter(Vehicle.device_id == device_id).first()
        if vehicle is None:
            logger.info("Unknown device_id %s — dropping", device_id)
            return None

        trip = (
            db.query(Trip)
            .filter(Trip.vehicle_id == vehicle.id, Trip.status == "active")
            .first()
        )
        if trip is None:
            logger.debug("No active trip for %s — dropping", device_id)
            return None

        reading = Reading(
            trip_id=trip.id,
            vehicle_id=vehicle.id,
            org_id=vehicle.org_id,
            timestamp=_parse_timestamp(payload.get("timestamp")),
            temperature=optional_float("temperature"),
            humidity=optional_float("humidity"),
            dew_point=optional_float("dew_point"),
            elevation=optional_float("elevation"),
            latitude=latitude,
            longitude=longitude,
        )
        db.add(reading)
        db.commit()
        db.refresh(reading)

        org = db.query(Organization).filter(Organization.id == vehicle.org_id).first()
        publish_telemetry(reading_payload(reading, vehicle, org.name if org else None))
        evaluate_route_compliance(db, trip, vehicle, latitude, longitude)
        return reading
    except Exception:
        db.rollback()
        logger.exception("Failed to ingest telemetry for %s", device_id)
        return None
    finally:
        db.close()


def _on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0 or str(reason_code) == "Success":
        client.subscribe(MQTT_TOPIC)
        logger.info("MQTT connected, subscribed to %s", MQTT_TOPIC)
    else:
        logger.error("MQTT connect failed: %s", reason_code)


def _on_message(client, userdata, message):
    try:
        payload = json.loads(message.payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        logger.warning("Invalid MQTT payload on %s", message.topic)
        return
    if not isinstance(payload, dict):
        logger.warning("MQTT payload is not an object: %s", payload)
        return
    ingest_telemetry(payload, message.topic)


def start_mqtt() -> mqtt.Client:
    global _mqtt_client
    client_id = os.getenv("MQTT_CLIENT_ID", f"swasemi-api-{uuid.uuid4().hex[:8]}")
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=client_id,
        protocol=mqtt.MQTTv311,
    )
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    client.on_connect = _on_connect
    client.on_message = _on_message
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()
    _mqtt_client = client
    logger.info("MQTT connecting to %s:%s", MQTT_HOST, MQTT_PORT)
    return client


def stop_mqtt() -> None:
    global _mqtt_client
    if _mqtt_client is None:
        return
    _mqtt_client.loop_stop()
    _mqtt_client.disconnect()
    _mqtt_client = None
