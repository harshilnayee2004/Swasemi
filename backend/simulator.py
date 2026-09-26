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
# Distance travelled per publish tick. 30 m every 2 s is roughly 55 km/h city driving.
STEP_METERS = float(os.getenv("SIMULATOR_STEP_METERS", "30"))
DEVIATION_METERS = float(os.getenv("ROUTE_DEVIATION_METERS", "200"))
EARTH_RADIUS_M = 6_371_000

MQTT_HOST = os.getenv("MQTT_HOST", "broker.emqx.io")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
MQTT_TOPIC_TEMPLATE = os.getenv(
    "MQTT_PUBLISH_TOPIC_TEMPLATE",
    "swasemi/fleet/{device_id}/readings",
)

# A loop through Gandhinagar, Gujarat: Sachivalaya → Mahatma Mandir → Akshardham →
# Sector 28 → Indroda Nature Park → Sector 11 → back. Waypoints are interpolated so
# vehicles advance a fixed distance every tick; all vehicles share the loop and start
# at different points along it, so they look like a fleet on the same corridor.
WAYPOINTS = [
    (23.2205, 72.6480),
    (23.2243, 72.6582),
    (23.2277, 72.6715),
    (23.2170, 72.6760),
    (23.2075, 72.6660),
    (23.2020, 72.6520),
    (23.2060, 72.6380),
    (23.2130, 72.6360),
]


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _destination(lat: float, lon: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    bearing = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    angular = distance_m / EARTH_RADIUS_M
    lat2 = math.asin(
        math.sin(lat1) * math.cos(angular) + math.cos(lat1) * math.sin(angular) * math.cos(bearing)
    )
    lon2 = lon1 + math.atan2(
        math.sin(bearing) * math.sin(angular) * math.cos(lat1),
        math.cos(angular) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


def _bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def densify(waypoints: list[tuple[float, float]], step_m: float) -> list[tuple[float, float]]:
    closed = waypoints + [waypoints[0]]
    path: list[tuple[float, float]] = []
    for (lat_a, lon_a), (lat_b, lon_b) in zip(closed, closed[1:]):
        steps = max(1, round(_haversine_m((lat_a, lon_a), (lat_b, lon_b)) / step_m))
        for index in range(steps):
            t = index / steps
            path.append((lat_a + (lat_b - lat_a) * t, lon_a + (lon_b - lon_a) * t))
    return path


BASE_ROUTE = densify(WAYPOINTS, STEP_METERS)


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

    def list_vehicles(self) -> list[dict[str, Any]]:
        vehicles = self._request("GET", "/vehicles")
        return vehicles if isinstance(vehicles, list) else []

    def has_active_trip(self, vehicle_id: int) -> bool:
        return self.active_trip(vehicle_id) is not None

    def active_trip(self, vehicle_id: int) -> dict[str, Any] | None:
        trips = self._request("GET", f"/vehicles/{vehicle_id}/trips")
        return next((trip for trip in trips if trip["status"] == "active"), None)


class SimulatedVehicle:
    def __init__(self, vehicle: dict[str, Any], route_index: int) -> None:
        self.id = vehicle["id"]
        self.name = vehicle["name"]
        self.device_id = vehicle["device_id"]
        self.route = BASE_ROUTE
        # Spread the fleet evenly around the loop.
        self.position = (route_index * len(self.route) // max(1, VEHICLE_COUNT)) % len(self.route)
        self.sample_number = 0
        self.deviate_ticks = 0

    def next_reading(self, force_deviate: bool = False) -> dict[str, Any]:
        # Occasionally hold position for a tick, like a signal or traffic stop.
        if random.random() > 0.08:
            self.position = (self.position + 1) % len(self.route)
        latitude, longitude = self.route[self.position]
        nxt = self.route[(self.position + 1) % len(self.route)]
        if force_deviate:
            self.deviate_ticks += 1
            offset_m = DEVIATION_METERS + 40 + self.deviate_ticks * 15
            heading = _bearing_deg((latitude, longitude), nxt)
            latitude, longitude = _destination(latitude, longitude, heading + 90, offset_m)
        else:
            self.deviate_ticks = 0
            latitude += random.uniform(-0.00002, 0.00002)
            longitude += random.uniform(-0.00002, 0.00002)
        self.sample_number += 1

        phase = self.sample_number / 5
        temperature = 33 + math.sin(phase) * 3 + random.uniform(-0.2, 0.2)
        humidity = 45 + math.cos(phase / 2) * 10 + random.uniform(-0.5, 0.5)
        # This approximation is adequate for plausible simulator data.
        dew_point = temperature - ((100 - humidity) / 5)
        # Gandhinagar sits at roughly 80 m above sea level.
        elevation = 81 + math.sin(phase / 3) * 3

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
    api = ApiClient(API_URL, EMAIL, PASSWORD)
    api.login()
    fleet: dict[int, SimulatedVehicle] = {}
    logger.info("Simulator waiting for user-created vehicles and started trips")

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
            try:
                listed = api.list_vehicles()
            except ApiError as exc:
                logger.error("Could not list vehicles: %s", exc)
                if not stopping:
                    time.sleep(PUBLISH_INTERVAL_SECONDS)
                continue
            for index, raw in enumerate(listed):
                vehicle_id = int(raw["id"])
                if vehicle_id not in fleet:
                    fleet[vehicle_id] = SimulatedVehicle(raw, index)
                    logger.info("Tracking %s (%s)", raw["name"], raw["device_id"])
            active_count = 0
            for raw in listed:
                vehicle = fleet[int(raw["id"])]
                try:
                    trip = api.active_trip(vehicle.id)
                    if trip is None:
                        continue
                    active_count += 1
                    payload = vehicle.next_reading(force_deviate=bool(trip.get("force_deviate")))
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
