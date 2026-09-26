import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy.orm import Session

from auth import get_current_org_user, get_current_user
from database import get_db
from geo import parse_route_file
from models import Alert, Organization, Reading, RoutePoint, Trip, User, Vehicle, VehicleRoutePoint
from schemas import PlannedRouteOut, RoutePointOut, VehicleCreate, VehicleOut

router = APIRouter(prefix="/vehicles", tags=["vehicles"])


def _vehicle_out(vehicle: Vehicle, org_name: str | None) -> VehicleOut:
    return VehicleOut(
        id=vehicle.id,
        org_id=vehicle.org_id,
        name=vehicle.name,
        device_id=vehicle.device_id,
        org_name=org_name,
        created_at=vehicle.created_at,
    )


@router.post("", response_model=VehicleOut, status_code=status.HTTP_201_CREATED)
def create_vehicle(
    body: VehicleCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = Vehicle(
        org_id=user.org_id,
        name=body.name,
        device_id=f"veh-{uuid.uuid4().hex[:12]}",
    )
    db.add(vehicle)
    db.commit()
    db.refresh(vehicle)
    org = db.query(Organization).filter(Organization.id == vehicle.org_id).first()
    return _vehicle_out(vehicle, org.name if org else None)


@router.get("", response_model=list[VehicleOut])
def list_vehicles(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = (
        db.query(Vehicle, Organization.name)
        .join(Organization, Vehicle.org_id == Organization.id)
        .order_by(Vehicle.id)
    )
    if user.role == "user":
        query = query.filter(Vehicle.org_id == user.org_id)
    elif user.role != "super_admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid role",
        )

    rows = query.all()
    return [_vehicle_out(vehicle, org_name) for vehicle, org_name in rows]


@router.delete("/{vehicle_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vehicle(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if vehicle is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    _require_vehicle_in_user_org(vehicle, user)

    trip_ids = [
        trip_id
        for (trip_id,) in db.query(Trip.id).filter(Trip.vehicle_id == vehicle.id).all()
    ]
    db.query(Alert).filter(Alert.vehicle_id == vehicle.id).delete(synchronize_session=False)
    db.query(Reading).filter(Reading.vehicle_id == vehicle.id).delete(synchronize_session=False)
    if trip_ids:
        db.query(RoutePoint).filter(RoutePoint.trip_id.in_(trip_ids)).delete(synchronize_session=False)
    db.query(Trip).filter(Trip.vehicle_id == vehicle.id).delete(synchronize_session=False)
    db.query(VehicleRoutePoint).filter(VehicleRoutePoint.vehicle_id == vehicle.id).delete(
        synchronize_session=False
    )
    db.delete(vehicle)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _require_vehicle_in_user_org(vehicle: Vehicle, user: User) -> None:
    if vehicle.org_id != user.org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Vehicle does not belong to your organization",
        )


def _planned_out(vehicle_id: int, points: list[VehicleRoutePoint]) -> PlannedRouteOut:
    return PlannedRouteOut(
        vehicle_id=vehicle_id,
        point_count=len(points),
        points=[
            RoutePointOut(seq=point.seq, latitude=point.latitude, longitude=point.longitude)
            for point in points
        ],
    )


@router.post("/{vehicle_id}/planned-route", response_model=PlannedRouteOut)
def save_planned_route(
    vehicle_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if vehicle is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    _require_vehicle_in_user_org(vehicle, user)
    raw = file.file.read()
    try:
        points = parse_route_file(file.filename or "route.kml", raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc) if str(exc) else "Could not parse route file",
        ) from exc
    db.query(VehicleRoutePoint).filter(VehicleRoutePoint.vehicle_id == vehicle.id).delete()
    stored = [
        VehicleRoutePoint(vehicle_id=vehicle.id, seq=index, latitude=latitude, longitude=longitude)
        for index, (latitude, longitude) in enumerate(points)
    ]
    db.add_all(stored)
    db.commit()
    return _planned_out(vehicle.id, stored)


@router.get("/{vehicle_id}/planned-route", response_model=PlannedRouteOut)
def get_planned_route(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if vehicle is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    if user.role == "user" and vehicle.org_id != user.org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Vehicle does not belong to your organization",
        )
    points = (
        db.query(VehicleRoutePoint)
        .filter(VehicleRoutePoint.vehicle_id == vehicle.id)
        .order_by(VehicleRoutePoint.seq)
        .all()
    )
    return _planned_out(vehicle.id, points)
