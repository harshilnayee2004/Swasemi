import logging
import threading

from mqtt_ingest import ingest_telemetry
from simulator import PUBLISH_INTERVAL_SECONDS, SimulatedVehicle

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_running: set[int] = set()
_fleet: dict[int, SimulatedVehicle] = {}
_thread: threading.Thread | None = None
_stop = threading.Event()


def is_running(vehicle_id: int) -> bool:
    return vehicle_id in _running


def running_ids() -> list[int]:
    return sorted(_running)


def start_vehicle(vehicle_id: int, device_id: str, name: str) -> None:
    global _thread
    with _lock:
        _running.add(vehicle_id)
        if vehicle_id not in _fleet:
            _fleet[vehicle_id] = SimulatedVehicle(
                {"id": vehicle_id, "device_id": device_id, "name": name},
                len(_fleet),
            )
        if _thread is None or not _thread.is_alive():
            _stop.clear()
            _thread = threading.Thread(target=_loop, name="live-sim", daemon=True)
            _thread.start()
            logger.info("In-process simulator thread started")
        logger.info("Simulator streaming %s (%s)", name, device_id)


def stop_vehicle(vehicle_id: int) -> None:
    with _lock:
        _running.discard(vehicle_id)
    logger.info("Simulator stopped for vehicle %s", vehicle_id)


def shutdown() -> None:
    _stop.set()
    with _lock:
        _running.clear()


def _loop() -> None:
    from database import SessionLocal
    from models import Trip

    while True:
        with _lock:
            ids = list(_running)
        if not ids:
            if _stop.wait(PUBLISH_INTERVAL_SECONDS):
                break
            continue
        db = SessionLocal()
        try:
            for vehicle_id in ids:
                vehicle = _fleet.get(vehicle_id)
                if vehicle is None:
                    continue
                trip = (
                    db.query(Trip)
                    .filter(Trip.vehicle_id == vehicle_id, Trip.status == "active")
                    .first()
                )
                if trip is None:
                    continue
                payload = vehicle.next_reading(force_deviate=bool(trip.force_deviate))
                ingest_telemetry(payload)
        except Exception:
            logger.exception("In-process simulator tick failed")
        finally:
            db.close()
        if _stop.wait(PUBLISH_INTERVAL_SECONDS):
            break
