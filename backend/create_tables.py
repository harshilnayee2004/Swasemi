from sqlalchemy import text

from database import Base, engine
import models  # noqa: F401  — register models on Base.metadata


def ensure_trip_force_deviate() -> None:
    # create_all will not add columns to an existing trips table.
    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE trips ADD COLUMN IF NOT EXISTS "
                "force_deviate BOOLEAN NOT NULL DEFAULT false"
            )
        )


if __name__ == "__main__":
    Base.metadata.create_all(bind=engine)
    ensure_trip_force_deviate()
    print("Tables created.")
