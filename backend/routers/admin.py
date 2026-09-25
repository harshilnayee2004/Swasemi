from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from auth import get_current_super_admin, hash_password
from database import get_db
from models import Organization, User
from schemas import OrganizationCreate, OrganizationOut, UserCreate, UserOut

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
