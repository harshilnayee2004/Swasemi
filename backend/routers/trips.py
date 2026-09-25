from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_org_user, get_current_user
from database import get_db
from geo import parse_route_file
from models import Alert, Reading, RoutePoint, Trip, User, Vehicle
from schemas import AlertOut, ReadingOut, RouteOut, RoutePointOut, TripOut

router = APIRouter(tags=["trips"])


def _get_vehicle(db: Session, vehicle_id: int) -> Vehicle:
    vehicle = db.query(Vehicle).filter(Vehicle.id == vehicle_id).first()
    if vehicle is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Vehicle not found",
        )
    return vehicle


def _require_vehicle_in_user_org(vehicle: Vehicle, user: User) -> None:
    if vehicle.org_id != user.org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Vehicle does not belong to your organization",
        )


def _active_trip(db: Session, vehicle_id: int) -> Trip | None:
    return (
        db.query(Trip)
        .filter(Trip.vehicle_id == vehicle_id, Trip.status == "active")
        .first()
    )


@router.post(
    "/vehicles/{vehicle_id}/trips/start",
    response_model=TripOut,
    status_code=status.HTTP_201_CREATED,
)
def start_trip(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = _get_vehicle(db, vehicle_id)
    _require_vehicle_in_user_org(vehicle, user)

    if _active_trip(db, vehicle.id) is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Vehicle already has an active trip",
        )

    trip = Trip(
        vehicle_id=vehicle.id,
        org_id=vehicle.org_id,
        status="active",
        started_at=datetime.now(timezone.utc),
        ended_at=None,
    )
    db.add(trip)
    db.commit()
    db.refresh(trip)
    return trip


@router.post("/vehicles/{vehicle_id}/trips/stop", response_model=TripOut)
def stop_trip(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    vehicle = _get_vehicle(db, vehicle_id)
    _require_vehicle_in_user_org(vehicle, user)

    trip = _active_trip(db, vehicle.id)
    if trip is None or trip.org_id != user.org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active trip for this vehicle",
        )

    trip.status = "completed"
    trip.ended_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(trip)
    return trip


@router.get("/vehicles/{vehicle_id}/trips", response_model=list[TripOut])
def list_trips(
    vehicle_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    vehicle = _get_vehicle(db, vehicle_id)
    if user.role == "user":
        _require_vehicle_in_user_org(vehicle, user)
    elif user.role != "super_admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid role",
        )

    return (
        db.query(Trip)
        .filter(Trip.vehicle_id == vehicle.id)
        .order_by(Trip.id.desc())
        .all()
    )


def _visible_trip(db: Session, vehicle_id: int, trip_id: int, user: User) -> tuple[Vehicle, Trip]:
    vehicle = _get_vehicle(db, vehicle_id)
    if user.role == "user":
        _require_vehicle_in_user_org(vehicle, user)
    elif user.role != "super_admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid role",
        )
    trip = (
        db.query(Trip)
        .filter(Trip.id == trip_id, Trip.vehicle_id == vehicle.id)
        .first()
    )
    if trip is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )
    return vehicle, trip


@router.post("/vehicles/{vehicle_id}/trips/{trip_id}/route", response_model=RouteOut)
def upload_route(
    vehicle_id: int,
    trip_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_org_user),
):
    _, trip = _visible_trip(db, vehicle_id, trip_id, user)
    if trip.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Route can only be uploaded for an active trip",
        )
    raw = file.file.read()
    try:
        content = raw.decode("utf-8")
        points = parse_route_file(file.filename or "route.kml", content)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc) if str(exc) else "Could not parse route file",
        ) from exc

    db.query(RoutePoint).filter(RoutePoint.trip_id == trip.id).delete()
    stored = [
        RoutePoint(trip_id=trip.id, seq=index, latitude=latitude, longitude=longitude)
        for index, (latitude, longitude) in enumerate(points)
    ]
    db.add_all(stored)
    db.commit()
    return RouteOut(
        trip_id=trip.id,
        point_count=len(stored),
        points=[
            RoutePointOut(seq=point.seq, latitude=point.latitude, longitude=point.longitude)
            for point in stored
        ],
    )


@router.get("/vehicles/{vehicle_id}/trips/{trip_id}/route", response_model=RouteOut)
def get_route(
    vehicle_id: int,
    trip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _, trip = _visible_trip(db, vehicle_id, trip_id, user)
    points = (
        db.query(RoutePoint)
        .filter(RoutePoint.trip_id == trip.id)
        .order_by(RoutePoint.seq)
        .all()
    )
    return RouteOut(
        trip_id=trip.id,
        point_count=len(points),
        points=[
            RoutePointOut(seq=point.seq, latitude=point.latitude, longitude=point.longitude)
            for point in points
        ],
    )


@router.get("/vehicles/{vehicle_id}/trips/{trip_id}/alerts", response_model=list[AlertOut])
def list_alerts(
    vehicle_id: int,
    trip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _, trip = _visible_trip(db, vehicle_id, trip_id, user)
    return (
        db.query(Alert)
        .filter(Alert.trip_id == trip.id)
        .order_by(Alert.id.desc())
        .all()
    )


def _trip_readings(db: Session, trip_id: int) -> list[Reading]:
    return (
        db.query(Reading)
        .filter(Reading.trip_id == trip_id)
        .order_by(Reading.timestamp)
        .all()
    )


@router.get(
    "/vehicles/{vehicle_id}/trips/{trip_id}/readings",
    response_model=list[ReadingOut],
)
def list_readings(
    vehicle_id: int,
    trip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _, trip = _visible_trip(db, vehicle_id, trip_id, user)
    return _trip_readings(db, trip.id)


@router.get("/vehicles/{vehicle_id}/trips/{trip_id}/export.csv")
def export_trip_csv(
    vehicle_id: int,
    trip_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _, trip = _visible_trip(db, vehicle_id, trip_id, user)
    readings = _trip_readings(db, trip.id)

    def rows():
        yield (
            "timestamp,latitude,longitude,temperature,humidity,dew_point,elevation\n"
        )
        for reading in readings:
            yield (
                f"{reading.timestamp.isoformat() if reading.timestamp else ''},"
                f"{reading.latitude},{reading.longitude},"
                f"{'' if reading.temperature is None else reading.temperature},"
                f"{'' if reading.humidity is None else reading.humidity},"
                f"{'' if reading.dew_point is None else reading.dew_point},"
                f"{'' if reading.elevation is None else reading.elevation}\n"
            )

    filename = f"trip-{trip.id}-readings.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
