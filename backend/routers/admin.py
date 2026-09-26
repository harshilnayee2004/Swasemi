import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from auth import get_current_super_admin, hash_password
from database import get_db
from models import Invite, Organization, User
from schemas import InviteCreate, InviteOut, OrganizationCreate, OrganizationOut, UserCreate, UserOut

INVITE_HOURS = int(os.getenv("INVITE_EXPIRE_HOURS", "72"))


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
