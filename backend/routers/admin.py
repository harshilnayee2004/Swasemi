import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from auth import get_current_super_admin, hash_password
from database import get_db
from models import Alert, Invite, Organization, Reading, RoutePoint, Trip, User, Vehicle, VehicleRoutePoint
from schemas import (
    InviteCreate,
    InviteOut,
    OrganizationCreate,
    OrganizationOut,
    PlatformStatsOut,
    ResetPasswordRequest,
    UserCreate,
    UserOut,
    UserWithOrgOut,
)

INVITE_HOURS = int(os.getenv("INVITE_EXPIRE_HOURS", "72"))

DEMO_PASSWORDS = {
    "admin@example.com": "adminpass",
    "usera@example.com": "usera-pass",
    "userb@example.com": "userb-pass",
}


def _invite_url(token: str) -> str:
    origin = os.getenv("FRONTEND_PUBLIC_URL") or os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:5173",
    ).split(",")[0].strip()
    return f"{origin.rstrip('/')}/?invite={token}"


def _invite_out(invite: Invite, org_name: str) -> InviteOut:
    return InviteOut(
        id=invite.id,
        token=invite.token,
        org_id=invite.org_id,
        org_name=org_name,
        email=invite.email,
        invite_url=_invite_url(invite.token),
        expires_at=invite.expires_at,
        used_at=invite.used_at,
    )


router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/stats", response_model=PlatformStatsOut)
def get_platform_stats(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    total_users = db.query(User).count()
    total_organizations = db.query(Organization).count()
    total_vehicles = db.query(Vehicle).count()
    total_active_trips = db.query(Trip).filter(Trip.status == "active").count()
    total_readings = db.query(Reading).count()

    return PlatformStatsOut(
        total_users=total_users,
        total_organizations=total_organizations,
        total_vehicles=total_vehicles,
        total_active_trips=total_active_trips,
        total_readings=total_readings,
    )


@router.post("/organizations", response_model=OrganizationOut, status_code=status.HTTP_201_CREATED)
def create_organization(
    body: OrganizationCreate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    org = Organization(name=body.name)
    db.add(org)
    db.commit()
    db.refresh(org)
    return org


@router.get("/organizations", response_model=list[OrganizationOut])
def list_organizations(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    return db.query(Organization).order_by(Organization.id).all()


@router.delete("/organizations/{org_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_organization(
    org_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")

    # 1. Delete associated invites
    db.query(Invite).filter(Invite.org_id == org_id).delete(synchronize_session=False)

    # 2. Delete users in this organization
    db.query(User).filter(User.org_id == org_id).delete(synchronize_session=False)

    # 3. Get all vehicles belonging to this org
    vehicles = db.query(Vehicle).filter(Vehicle.org_id == org_id).all()
    vehicle_ids = [v.id for v in vehicles]

    if vehicle_ids:
        # Delete VehicleRoutePoint rows
        db.query(VehicleRoutePoint).filter(VehicleRoutePoint.vehicle_id.in_(vehicle_ids)).delete(synchronize_session=False)

        # Get all trip IDs for these vehicles
        trips = db.query(Trip).filter(Trip.vehicle_id.in_(vehicle_ids)).all()
        trip_ids = [t.id for t in trips]

        if trip_ids:
            db.query(Alert).filter(Alert.trip_id.in_(trip_ids)).delete(synchronize_session=False)
            db.query(RoutePoint).filter(RoutePoint.trip_id.in_(trip_ids)).delete(synchronize_session=False)
            db.query(Reading).filter(Reading.trip_id.in_(trip_ids)).delete(synchronize_session=False)
            db.query(Trip).filter(Trip.id.in_(trip_ids)).delete(synchronize_session=False)

        db.query(Alert).filter(Alert.org_id == org_id).delete(synchronize_session=False)
        db.query(Reading).filter(Reading.org_id == org_id).delete(synchronize_session=False)

        db.query(Vehicle).filter(Vehicle.org_id == org_id).delete(synchronize_session=False)

    db.delete(org)
    db.commit()


@router.get("/users", response_model=list[UserWithOrgOut])
def list_all_users(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    # Left join to include super admins (org_id is None)
    results = (
        db.query(User, Organization.name.label("org_name"))
        .outerjoin(Organization, User.org_id == Organization.id)
        .order_by(User.id)
        .all()
    )
    users_out = []
    for user, org_name in results:
        hint = DEMO_PASSWORDS.get(user.email.lower())
        users_out.append(
            UserWithOrgOut(
                id=user.id,
                email=user.email,
                role=user.role,
                org_id=user.org_id,
                org_name=org_name,
                password_hint=hint,
                created_at=user.created_at,
            )
        )
    return users_out


@router.post("/users/{user_id}/reset-password", status_code=status.HTTP_200_OK)
def reset_user_password(
    user_id: int,
    body: ResetPasswordRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    return {"status": "ok", "message": f"Password updated for {user.email}"}


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    if body.org_id is not None:
        org = db.query(Organization).filter(Organization.id == body.org_id).first()
        if org is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Organization not found",
            )

    existing = db.query(User).filter(User.email == body.email).first()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already in use",
        )

    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        role=body.role,
        org_id=body.org_id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.get("/organizations/{org_id}/users", response_model=list[UserOut])
def list_organization_users(
    org_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )
    return db.query(User).filter(User.org_id == org_id).order_by(User.id).all()


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_super_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.role == "super_admin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Super admin accounts cannot be deleted",
        )
    db.delete(user)
    db.commit()


@router.post("/invites", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
def create_invite(
    body: InviteCreate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    org = db.query(Organization).filter(Organization.id == body.org_id).first()
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
    if body.email:
        existing = db.query(User).filter(User.email == body.email).first()
        if existing is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use")
    invite = Invite(
        token=secrets.token_urlsafe(24),
        org_id=org.id,
        email=body.email,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=INVITE_HOURS),
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return _invite_out(invite, org.name)


@router.get("/invites", response_model=list[InviteOut])
def list_invites(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    rows = (
        db.query(Invite, Organization.name)
        .join(Organization, Invite.org_id == Organization.id)
        .order_by(Invite.id.desc())
        .all()
    )
    return [_invite_out(invite, org_name) for invite, org_name in rows]


@router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_invite(
    invite_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_super_admin),
):
    invite = db.query(Invite).filter(Invite.id == invite_id).first()
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    db.delete(invite)
    db.commit()
