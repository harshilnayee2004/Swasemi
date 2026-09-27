import logging
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import Base, engine, SessionLocal
import models  # noqa: F401
from auth import hash_password

logger = logging.getLogger(__name__)


def ensure_trip_force_deviate() -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE trips ADD COLUMN IF NOT EXISTS "
                "force_deviate BOOLEAN NOT NULL DEFAULT false"
            )
        )


def seed_initial_data(db: Session) -> None:
    # Check if Super Admin exists
    admin = db.query(models.User).filter_by(email="admin@example.com").first()
    if not admin:
        logger.info("Seeding Super Admin user...")
        admin = models.User(
            email="admin@example.com",
            password_hash=hash_password("adminpass"),
            role="super_admin",
            org_id=None,
        )
        db.add(admin)

    # Check if Org A exists
    org_a = db.query(models.Organization).filter_by(name="Logistics Alpha").first()
    if not org_a:
        logger.info("Seeding Organization Alpha...")
        org_a = models.Organization(name="Logistics Alpha")
        db.add(org_a)
        db.flush()

    user_a = db.query(models.User).filter_by(email="usera@example.com").first()
    if not user_a:
        user_a = models.User(
            email="usera@example.com",
            password_hash=hash_password("usera-pass"),
            role="user",
            org_id=org_a.id,
        )
        db.add(user_a)

    vehicle_a = db.query(models.Vehicle).filter_by(device_id="SW-TRUCK-001").first()
    if not vehicle_a:
        vehicle_a = models.Vehicle(
            name="Truck Alpha-1",
            device_id="SW-TRUCK-001",
            org_id=org_a.id,
        )
        db.add(vehicle_a)
        db.flush()


    # Check if Org B exists
    org_b = db.query(models.Organization).filter_by(name="Transporter Beta").first()
    if not org_b:
        logger.info("Seeding Organization Beta...")
        org_b = models.Organization(name="Transporter Beta")
        db.add(org_b)
        db.flush()

    user_b = db.query(models.User).filter_by(email="userb@example.com").first()
    if not user_b:
        user_b = models.User(
            email="userb@example.com",
            password_hash=hash_password("userb-pass"),
            role="user",
            org_id=org_b.id,
        )
        db.add(user_b)

    vehicle_b = db.query(models.Vehicle).filter_by(device_id="SW-VAN-002").first()
    if not vehicle_b:
        vehicle_b = models.Vehicle(
            name="Van Beta-1",
            device_id="SW-VAN-002",
            org_id=org_b.id,
        )
        db.add(vehicle_b)
        db.flush()


    db.commit()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_trip_force_deviate()
    with SessionLocal() as db:
        seed_initial_data(db)
    print("Database tables initialized and seeded successfully.")


if __name__ == "__main__":
    init_db()
