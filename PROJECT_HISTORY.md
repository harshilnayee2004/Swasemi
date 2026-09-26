# Fleet Telemetry Platform — Build History and Interview Notes

This document is the running engineering record for the assignment. Update it whenever the project changes. It explains what exists, why each decision was made, how data moves through the system, and what remains.

## 1. Assignment summary

The application is a multi-tenant fleet telemetry platform:

- A `User` belongs to one organization and can only access that organization's data.
- A `super_admin` belongs to no organization and can view all organizations.
- Onboarding is invite-only; there is no public signup.
- A vehicle only records telemetry while it has an active trip.
- Simulated devices publish GPS and environmental telemetry over MQTT.
- The API persists accepted readings to PostgreSQL, publishes live events through Redis, and delivers them to dashboards over WebSockets.

Required stack: Python 3.11+, FastAPI, Pydantic v2, SQLAlchemy, PostgreSQL, Redis, MQTT through `broker.emqx.io`, JWT bearer authentication, and React + TypeScript + Vite.

## 2. Work completed on 2026-09-25

See local PROJECT_HISTORY.md for the full interview record covering infrastructure, auth, vehicles, trips, MQTT, simulator, dashboard, deviation, delete-vehicle, verification, structure, and interview manual.
