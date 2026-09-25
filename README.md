# Swasemi Fleet Telemetry

Multi-tenant fleet dashboard: FastAPI, Postgres, Redis, MQTT, React.

Design notes and verification are in [PROJECT_HISTORY.md](PROJECT_HISTORY.md).

## Local run

1. `docker compose up -d` (Postgres on 5433, Redis on 6379)
2. Backend: copy `backend/.env.example` to `backend/.env`, create a venv, `pip install -r backend/requirements.txt`, run `python create_tables.py`, then `python -m uvicorn main:app --host 127.0.0.1 --port 8000`
3. Frontend: `cd frontend && npm install && npm run dev`
4. Simulator (optional): `python simulator.py` from `backend/` while at least one trip is active

## Demo logins (local seed)

| Role | Email | Password |
| --- | --- | --- |
| Super Admin | `admin@example.com` | `adminpass` |
| Org A user | `usera@example.com` | `usera-pass` |
| Org B user | `userb@example.com` | `userb-pass` |

There is no public signup. `admin@astermedcare.com` is not a seeded account.
