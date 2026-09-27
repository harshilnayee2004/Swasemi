from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_org_user
from database import get_db
import live_sim
from models import User, Vehicle, VehicleRoutePoint
from routers.trips import _active_trip, start_trip
from simulator import WAYPOINTS

router = APIRouter(tags=["simulator"])


class SimulatorOut(BaseModel):
    vehicle_id: int
    running: bool
    trip_id: int | None = None


def _get_owned_vehicle(db: Session, vehicle_id: int, user: User) -> Vehicle:
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if vehicle is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    if vehicle.org_id != user.org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Vehicle does not belong to your organization",
        )
    return vehicle


def _ensure_planned_route(db: Session, vehicle: Vehicle) -> None:
    count = (
        db.query(VehicleRoutePoint)
        .filter(VehicleRoutePoint.vehicle_id == vehicle.id)
        .count()
    )
    if count >= 2:
        return
    db.query(VehicleRoutePoint).filter(VehicleRoutePoint.vehicle_id == vehicle.id).delete()
    db.add_all(
        VehicleRoutePoint(
            vehicle_id=vehicle.id,
            seq=index,
            latitude=latitude,
            longitude=longitude,
        )
        for index, (latitude, longitude) in enumerate(WAYPOINTS)
    )
    db.commit()


@router.get("/vehicles/{vehicle_id}/simulator", response_model=SimulatorOut)
def simulator_status(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = _get_owned_vehicle(db, vehicle_id, user)
    active = _active_trip(db, vehicle.id)
    return SimulatorOut(
        vehicle_id=vehicle.id,
        running=live_sim.is_running(vehicle.id),
        trip_id=active.id if active else None,
    )


@router.post("/vehicles/{vehicle_id}/simulator/start", response_model=SimulatorOut)
def start_simulator(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = _get_owned_vehicle(db, vehicle_id, user)
    _ensure_planned_route(db, vehicle)
    trip = _active_trip(db, vehicle.id)
    if trip is None:
        trip = start_trip(vehicle_id, db, user)
    live_sim.start_vehicle(vehicle.id, vehicle.device_id, vehicle.name)
    return SimulatorOut(vehicle_id=vehicle.id, running=True, trip_id=trip.id)


@router.post("/vehicles/{vehicle_id}/simulator/stop", response_model=SimulatorOut)
def stop_simulator(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = _get_owned_vehicle(db, vehicle_id, user)
    live_sim.stop_vehicle(vehicle.id)
    active = _active_trip(db, vehicle.id)
    return SimulatorOut(
        vehicle_id=vehicle.id,
        running=False,
        trip_id=active.id if active else None,
    )
