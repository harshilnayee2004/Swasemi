import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from auth import get_current_org_user, get_current_user
from database import get_db
from models import Organization, User, Vehicle
from schemas import VehicleCreate, VehicleOut

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
