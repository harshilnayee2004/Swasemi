# Swasemi Fleet Telemetry

Multi-tenant fleet telemetry demo built with FastAPI, PostgreSQL, Redis, MQTT, and React + TypeScript + Vite. Design notes and interview material live in [PROJECT_HISTORY.md](PROJECT_HISTORY.md).

## Containerized Demo Deployment

Run the complete single-host demo stack with Docker Compose:

```bash
docker compose up --build -d
```

This starts PostgreSQL (`5433`), Redis (`6379`), the FastAPI API (`8000`), the simulator, and the frontend (`80` and `5173`). Visit http://localhost:5173/ and http://localhost:8000/docs.

Do not run this mode at the same time as `start-all.ps1`: both use the same host ports.

## Local Windows Development

```powershell
.\start-all.ps1
```

The launcher starts only the Postgres and Redis Compose services, then launches the backend, Vite frontend, and simulator locally. Its health check confirms both Postgres and Redis are reachable before the demo continues.

## Separate Frontend Deployment

`frontend/Dockerfile` and `frontend/nginx.conf` serve static Vite assets only; Nginx does not proxy to a Docker-only `backend` hostname. All browser API and WebSocket traffic is driven by build-time `VITE_API_URL` and `VITE_WS_URL` in [frontend/src/api.ts](frontend/src/api.ts).

For a separately hosted frontend, build it with public backend URLs, for example:

```bash
docker build frontend --build-arg VITE_API_URL=https://api.example.com --build-arg VITE_WS_URL=wss://api.example.com/ws
```

Set `FRONTEND_ORIGINS` on the backend to the deployed frontend origin. `FRONTEND_PUBLIC_URL` controls generated invite links.

## Configuration and Alerts

Copy `backend/.env.example` to `backend/.env` for local configuration. `backend/.env` is ignored by Git and must never be committed or included in a submission archive. Rotate any credential that has been shared outside the repository, including the SMTP Gmail App Password, directly in the Gmail account and update only the local ignored `.env` file.

`JWT_SECRET` may use the development fallback only when `ENVIRONMENT=development`; every other environment must define a real secret. Demo recipient domains (`example.com`, `example.org`, `example.net`, `localhost`, and `invalid`) are intentionally filtered from SMTP delivery. Alerts are still stored and displayed; use a real email domain to test mail delivery.

Demo password hints in the Super Admin response are disabled by default. Set `EXPOSE_DEMO_PASSWORD_HINTS=true` only for a controlled demo.

## Tests and Checks

```powershell
cd backend
pytest
python -m compileall .
cd ..\frontend
npm run typecheck
npm run build
```

## Demo Logins

| Role | Email | Password | Scope |
| --- | --- | --- | --- |
| Super Admin | `admin@example.com` | `adminpass` | Views all organizations and fleets |
| Org A User | `usera@example.com` | `usera-pass` | Logistics Alpha fleet |
| Org B User | `userb@example.com` | `userb-pass` | Transporter Beta fleet |

On a fresh database, demo vehicles are seeded without active trips. Save a planned route and press **Start Trip** before the simulator produces persisted telemetry.
