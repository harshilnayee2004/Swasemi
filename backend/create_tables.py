from database import Base, engine
import models  # noqa: F401  — register models on Base.metadata


if __name__ == "__main__":
    Base.metadata.create_all(bind=engine)
    print("Tables created.")
