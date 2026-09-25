from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, model_validator


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenPayload(BaseModel):
    sub: int
    role: str
    org_id: Optional[int] = None


class OrganizationCreate(BaseModel):
    name: str


class OrganizationOut(BaseModel):
    id: int
    name: str
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    role: Literal["user", "super_admin"]
    org_id: Optional[int] = None

    @model_validator(mode="after")
    def validate_org_for_role(self):
        if self.role == "user" and self.org_id is None:
            raise ValueError("org_id is required when role is user")
        if self.role == "super_admin" and self.org_id is not None:
            raise ValueError("org_id must be null when role is super_admin")
        return self


class UserOut(BaseModel):
    id: int
    email: EmailStr
    role: str
    org_id: Optional[int] = None

    model_config = {"from_attributes": True}


class VehicleCreate(BaseModel):
    name: str


class VehicleOut(BaseModel):
    id: int
    org_id: int
    name: str
    device_id: str
    org_name: Optional[str] = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class TripOut(BaseModel):
    id: int
    vehicle_id: int
    org_id: int
    status: str
    started_at: datetime
    ended_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class RoutePointOut(BaseModel):
    seq: int
    latitude: float
    longitude: float

    model_config = {"from_attributes": True}


class RouteOut(BaseModel):
    trip_id: int
    point_count: int
    points: list[RoutePointOut]


class AlertOut(BaseModel):
    id: int
    trip_id: int
    vehicle_id: int
    org_id: int
    type: str
    message: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    created_at: datetime | None = None
    emailed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ReadingOut(BaseModel):
    id: int
    trip_id: int
    vehicle_id: int
    timestamp: datetime
    temperature: Optional[float] = None
    humidity: Optional[float] = None
    dew_point: Optional[float] = None
    elevation: Optional[float] = None
    latitude: float
    longitude: float

    model_config = {"from_attributes": True}
