# Swasemi Fleet Telemetry

Multi-tenant fleet telemetry platform built with FastAPI, PostgreSQL, Redis, MQTT, and React + TypeScript + Vite.

Design notes, architectural verification, and interview questions are in [PROJECT_HISTORY.md](PROJECT_HISTORY.md).

---

## 🚀 One-Command Deployment (Production / Cloud / Staging)

To deploy the entire platform (Database, Cache, Backend API, Automated Simulator, and Frontend):

```bash
docker compose up --build -d
```

This single command automatically starts:
- **PostgreSQL 16** (Port `5433:5432`)
- **Redis 7** (Port `6379:6379`)
- **FastAPI Backend** (Port `8000`) - auto-creates and seeds database tables
- **Telemetry Simulator** (Background Worker) - automatically generates live vehicle telemetry
- **React Frontend (Nginx)** (Port `80` & `5173`)

### Access URLs:
- **Dashboard**: http://localhost/ (or http://localhost:5173/)
- **API Docs**: http://localhost:8000/docs
- **Health Check**: http://localhost:8000/health

---

## 💻 Local Development Launcher

If developing locally on Windows:

```powershell
.\start-all.ps1
```

---

## 🔑 Demo Logins (Auto-Seeded)

| Role | Email | Password | Scope |
| --- | --- | --- | --- |
| **Super Admin** | `admin@example.com` | `adminpass` | Views all organizations & fleets |
| **Org A User** | `usera@example.com` | `usera-pass` | Logistics Alpha fleet |
| **Org B User** | `userb@example.com` | `userb-pass` | Transporter Beta fleet |

*Note: Onboarding is invite-only by design.*
