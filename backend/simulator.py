import json
import logging
import math
import os
import random
import signal
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

API_URL = os.getenv("SIMULATOR_API_URL", "http://127.0.0.1:8000").rstrip("/")
EMAIL = os.getenv("SIMULATOR_EMAIL")
PASSWORD = os.getenv("SIMULATOR_PASSWORD")
VEHICLE_COUNT = int(os.getenv("SIMULATOR_VEHICLE_COUNT", "3"))
PUBLISH_INTERVAL_SECONDS = float(os.getenv("SIMULATOR_INTERVAL_SECONDS", "2"))
MAX_CYCLES = int(os.getenv("SIMULATOR_MAX_CYCLES", "0"))

MQTT_HOST = os.getenv("MQTT_HOST", "broker.emqx.io")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
MQTT_TOPIC_TEMPLATE = os.getenv(
    "MQTT_PUBLISH_TOPIC_TEMPLATE",
    "swasemi/fleet/{device_id}/readings",
)

# A short Bengaluru route. Each simulated vehicle receives a small coordinate offset.
BASE_ROUTE = [
    (12.97160, 77.59460),
    (12.97224, 77.59605),
    (12.97305, 77.59748),
    (12.97412, 77.59862),
    (12.97531, 77.59939),
    (12.97662, 77.59974),
    (12.97787, 77.59930),
    (12.97871, 77.59817),
    (12.97882, 77.59663),
    (12.97816, 77.59518),
    (12.97691, 77.59437),
    (12.97534, 77.59408),
    (12.97377, 77.59420),
]


class ApiError(RuntimeError):
    pass


class ApiClient:
    def __init__(self, base_url: str, email: str, password: str) -> None:
        self.base_url = base_url
        self.email = email
        self.password = password
        self.token: str | None = None

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                content = response.read()
                return json.loads(content) if content else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise ApiError(f"{method} {path} returned {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"Cannot reach API at {self.base_url}: {exc.reason}") from exc

    def login(self) -> None:
        response = self._request(
            "POST",
            "/auth/login",
            {"email": self.email, "password": self.password},
        )
        self.token = response["access_token"]

    def ensure_vehicles(self, count: int) -> list[dict[str, Any]]:
        vehicles = self._request("GET", "/vehicles")
        missing = count - len(vehicles)
        for _ in range(missing):
            vehicles.append(
                self._request(
                    "POST",
                    "/vehicles",
                    {"name": f"Simulator Vehicle {len(vehicles) + 1}"},
                )
            )
        return vehicles[:count]

    def has_active_trip(self, vehicle_id: int) -> bool:
        trips = self._request("GET", f"/vehicles/{vehicle_id}/trips")
        return any(trip["status"] == "active" for trip in trips)


class SimulatedVehicle:
    def __init__(self, vehicle: dict[str, Any], route_index: int) -> None:
        self.id = vehicle["id"]
        self.name = vehicle["name"]
        self.device_id = vehicle["device_id"]
        self.position = route_index % len(BASE_ROUTE)
        self.sample_number = 0
        offset = route_index * 0.003
        self.route = [
            (latitude + offset, longitude + offset)
            for latitude, longitude in BASE_ROUTE
        ]

    def next_reading(self) -> dict[str, Any]:
        latitude, longitude = self.route[self.position]
        self.position = (self.position + 1) % len(self.route)
        self.sample_number += 1

        phase = self.sample_number / 5
        temperature = 25 + math.sin(phase) * 3 + random.uniform(-0.2, 0.2)
        humidity = 58 + math.cos(phase / 2) * 8 + random.uniform(-0.5, 0.5)
        # This approximation is adequate for plausible simulator data.
        dew_point = temperature - ((100 - humidity) / 5)
        elevation = 910 + math.sin(phase / 3) * 12

        return {
            "device_id": self.device_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "latitude": round(latitude, 6),
            "longitude": round(longitude, 6),
            "temperature": round(temperature, 2),
            "humidity": round(humidity, 2),
            "dew_point": round(dew_point, 2),
            "elevation": round(elevation, 2),
        }


def create_mqtt_client() -> mqtt.Client:
    connected = threading.Event()

    def on_connect(client, userdata, flags, reason_code, properties=None):
        if reason_code == 0 or str(reason_code) == "Success":
            connected.set()
            logger.info("Connected to MQTT broker %s:%s", MQTT_HOST, MQTT_PORT)
        else:
            logger.error("MQTT connection failed: %s", reason_code)

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"swasemi-simulator-{uuid.uuid4().hex[:8]}",
        protocol=mqtt.MQTTv311,
    )
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()
    if not connected.wait(timeout=15):
        client.loop_stop()
        client.disconnect()
        raise RuntimeError("Timed out connecting to the MQTT broker")
    return client


def run() -> None:
    if not EMAIL or not PASSWORD:
        raise SystemExit(
            "Set SIMULATOR_EMAIL and SIMULATOR_PASSWORD to an organization User. "
            "Super Admin credentials cannot operate vehicles."
        )
    if VEHICLE_COUNT < 3:
        raise SystemExit("SIMULATOR_VEHICLE_COUNT must be at least 3")

    api = ApiClient(API_URL, EMAIL, PASSWORD)
    api.login()
    vehicles = [
        SimulatedVehicle(vehicle, index)
        for index, vehicle in enumerate(api.ensure_vehicles(VEHICLE_COUNT))
    ]
    logger.info(
        "Ready with %s vehicles: %s",
        len(vehicles),
        ", ".join(f"{vehicle.name} ({vehicle.device_id})" for vehicle in vehicles),
    )

    mqtt_client = create_mqtt_client()
    stopping = False

    def request_stop(signum=None, frame=None):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    cycle = 0
    try:
        while not stopping and (MAX_CYCLES == 0 or cycle < MAX_CYCLES):
            cycle += 1
            active_count = 0
            for vehicle in vehicles:
                try:
                    if not api.has_active_trip(vehicle.id):
                        continue
                    active_count += 1
                    payload = vehicle.next_reading()
                    topic = MQTT_TOPIC_TEMPLATE.format(device_id=vehicle.device_id)
                    result = mqtt_client.publish(topic, json.dumps(payload), qos=1)
                    result.wait_for_publish(timeout=10)
                    logger.info(
                        "Published %s at (%s, %s)",
                        vehicle.name,
                        payload["latitude"],
                        payload["longitude"],
                    )
                except (ApiError, RuntimeError, ValueError) as exc:
                    logger.error("%s: %s", vehicle.name, exc)
            if active_count == 0:
                logger.info("No active trips; waiting")
            if not stopping:
                time.sleep(PUBLISH_INTERVAL_SECONDS)
    finally:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()
        logger.info("Simulator stopped")


if __name__ == "__main__":
    run()
