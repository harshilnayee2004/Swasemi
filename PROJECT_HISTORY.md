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

### Initial infrastructure

- Added Docker Compose services for PostgreSQL 16 and Redis 7.
- PostgreSQL is exposed locally on port `5433` to avoid conflicting with a default local PostgreSQL installation.
- Redis is exposed on its standard port `6379`.
- Created the FastAPI backend and a `/health` endpoint.
- Added environment-based configuration in `backend/.env`.

Why: PostgreSQL provides durable relational storage and queryable tenant ownership. Redis decouples MQTT ingestion from WebSocket clients, so slow dashboard consumers do not block device ingestion.

### Database layer

Added SQLAlchemy engine/session setup and these models:

- `Organization`: tenant record.
- `User`: login identity with role and nullable `org_id`; Super Admins deliberately have no organization.
- `Vehicle`: belongs to exactly one organization and has a unique MQTT `device_id`.
- `Trip`: belongs to a vehicle and organization, with `active`/`completed` status and start/end times.
- `Reading`: telemetry sample containing location, temperature, humidity, dew point, and elevation.
- `RoutePoint`: ordered point in a trip's planned route.
- `Alert`: tenant-scoped alert record, including email-delivery time.

`org_id` is intentionally denormalized onto `Trip`, `Reading`, and `Alert`. This makes tenant filters direct and easy to audit instead of requiring joins for every authorization-sensitive query.

Reading indexes:

- `(trip_id, timestamp)` supports chronological trip history and CSV export.
- `(vehicle_id, timestamp)` supports latest-position and vehicle-history queries.

Added `backend/create_tables.py` for this assignment stage. Alembic is intentionally deferred because the requested implementation uses `create_all` without migrations. The existing database received the later `Trip.status` column directly.

### Authentication

- Added password hashing with Passlib/bcrypt.
- Added JWT creation and decoding with an expiry.
- JWT claims carry user ID (`sub`), `role`, and `org_id`.
- Added `get_current_user`, `get_current_super_admin`, and `get_current_org_user`.
- Added `POST /auth/login`.
- No signup route exists, preserving invite-only onboarding.

Authorization uses the current database user after decoding the token. This means deleting a user immediately invalidates access even if an old JWT has not expired.

### Super Admin provisioning

Added protected routes:

- `POST /admin/organizations`
- `GET /admin/organizations`
- `POST /admin/users`
- `GET /admin/organizations/{org_id}/users`

Validation rules:

- A normal User must have an `org_id`.
- A Super Admin must have `org_id = null`.
- Duplicate emails return a conflict.
- Password hashes are never returned.

### Vehicle and trip control

Added:

- `POST /vehicles`: organization Users create vehicles only in their own organization.
- `GET /vehicles`: Users see only their tenant; Super Admin sees all vehicles with organization information.
- `POST /vehicles/{vehicle_id}/trips/start`
- `POST /vehicles/{vehicle_id}/trips/stop`
- `GET /vehicles/{vehicle_id}/trips`

Start/stop mutation is restricted to organization Users. A Super Admin has global visibility but cannot operate another tenant's fleet. Every URL containing a vehicle ID verifies tenant ownership; guessed cross-tenant IDs return `403`, and unknown IDs return `404`.

The trip gate prevents a second active trip for one vehicle. Stopping sets the status to `completed` and records `ended_at`.

### MQTT, Redis, and WebSockets

The API subscribes to:

`swasemi/fleet/+/readings`

Expected publication topic:

`swasemi/fleet/{device_id}/readings`

MQTT ingestion:

1. Parse and validate JSON.
2. Resolve the unique `device_id`.
3. Find an active trip for that vehicle.
4. Drop the message if the vehicle is unknown or has no active trip.
5. Store a tenant-scoped `Reading`.
6. Publish the accepted reading to Redis channel `fleet:telemetry`.

The WebSocket endpoint is:

`ws://localhost:8000/ws?token={JWT}`

Browsers cannot reliably attach arbitrary authorization headers during a WebSocket upgrade, so the assignment explicitly allows the JWT query parameter. On connection, the server sends a snapshot containing visible vehicles, last readings, and active trip IDs. Afterwards Redis messages are broadcast live. Tenant filtering is applied again before each WebSocket send:

- User: only messages whose `org_id` equals the User's organization.
- Super Admin: all organizations.

The Redis subscriber reconnects after transient Redis failures. SQLAlchemy uses `pool_pre_ping=True` so stale database connections are detected after Docker restarts.

### Three-vehicle device simulator

Added `backend/simulator.py` as the device-side process required by the assignment.

At startup it:

1. Requires an organization User's credentials through environment variables.
2. Logs into the API and receives a JWT.
3. Lists that User's vehicles and creates enough vehicles to reach the configured minimum of three.
4. Connects to `broker.emqx.io`.
5. Checks each vehicle's trip state through the tenant-scoped API.
6. Publishes only vehicles with an active trip.

Each vehicle follows a repeatable route with a small per-vehicle offset and emits:

- UTC timestamp
- Latitude and longitude
- Temperature
- Humidity
- Approximate dew point
- Elevation

The simulator and server both enforce the trip gate. This is intentional defense in depth: the simulator models correct device behavior, while the API remains authoritative if a buggy or malicious device publishes when stopped.

Simulator credentials are not embedded in source code. Set:

```powershell
$env:SIMULATOR_EMAIL="usera@example.com"
$env:SIMULATOR_PASSWORD="usera-pass"
python simulator.py
```

Press `Ctrl+C` for graceful shutdown. `SIMULATOR_INTERVAL_SECONDS` controls publication frequency. `SIMULATOR_VEHICLE_COUNT` may be greater than three but cannot be less than three.

### Source-control hygiene

- Added `.gitignore` to prevent local `.env`, virtual environments, caches, frontend dependencies, and build artifacts from being committed.
- Added `backend/.env.example` to document every required configuration key without storing real deployment secrets.

### React live fleet dashboard

Built the reviewer-facing application in `frontend/` with React, TypeScript, and Vite.

Implemented:

- Invite-only email/password login against `POST /auth/login`.
- Session restoration through the new authenticated `GET /auth/me` endpoint.
- JWT-authenticated WebSocket connection using the permitted query parameter.
- Initial fleet snapshot followed by live reading updates.
- Exponential WebSocket reconnect delay capped at ten seconds.
- OpenStreetMap map rendered with Leaflet/React Leaflet.
- Vehicle markers, selection, latest sensor values, and last-seen time.
- Stable online/offline state using a 20-second grace window, substantially longer than the simulator's default two-second interval.
- Organization User start/stop controls with immediate UI state updates.
- Super Admin all-fleet view and organization selector.
- Responsive desktop/mobile layouts.
- Visible connecting/live/reconnecting state.
- Empty, loading, authentication-error, and trip-action-error states.

Added CORS middleware to FastAPI. Allowed development origins come from `FRONTEND_ORIGINS`; production must provide its deployed frontend origin.

Leaflet was selected because it is lightweight, mature, and works directly with OpenStreetMap without requiring a paid map token. Circle markers avoid Leaflet's default marker-image asset configuration and make online/offline color changes straightforward.

The development client stores the JWT in `localStorage` to survive refreshes. This is simple for an assignment, but it makes strong XSS prevention important. A production security-hardening pass could use short-lived access tokens plus an HttpOnly refresh cookie.

### Planned route, deviation alerts, and email

A trip can receive a planned route after it is started (the assignment allows upload before or at start; attaching it to the active trip is the durable place to store it).

Organization Users upload a KML LineString or a simple `lat,lng` CSV to:

`POST /vehicles/{vehicle_id}/trips/{trip_id}/route`

The parser stores ordered `RoutePoint` rows. Re-uploading replaces the previous polyline. Super Admin can inspect the route and alerts but cannot upload, matching other trip mutations.

On every accepted reading the API:

1. Loads that trip's planned points.
2. Measures the shortest distance from the GPS sample to the polyline (haversine plus local-meter projection onto each segment).
3. If the distance exceeds `ROUTE_DEVIATION_METERS` (default 200 m), writes a `route_deviation` `Alert`.
4. Emails every User in that organization over SMTP and stamps `emailed_at` on success.
5. Publishes the alert on Redis so dashboards show it immediately.

A ten-minute cooldown (`ROUTE_ALERT_COOLDOWN_MINUTES`) prevents one noisy GPS glitch from generating a mail storm. If SMTP is unset, the Alert is still stored and the miss is logged — the assignment's "real email" requirement is met once `SMTP_HOST`, credentials, and `ALERT_FROM_EMAIL` are provided.

The dashboard draws the planned polyline, exposes Upload KML on an active trip, and shows the latest deviation banner. Sample files:

- `frontend/public/sample-route.kml` — matches the simulator corridor (should stay compliant).
- `frontend/public/off-route.kml` — far from the simulator (triggers alerts).

### Trip history, GPS trail, and CSV export

Selecting a vehicle and opening **View trip history** loads that vehicle's trips (newest first). Choosing a trip:

- Fetches its readings (tenant-scoped).
- Draws a temperature sparkline for that trip.
- Overlays the actual GPS trail on the live map (dashed blue) plus any stored planned route.
- Offers **Download CSV** from `GET /vehicles/{id}/trips/{trip_id}/export.csv`.

CSV columns: timestamp, latitude, longitude, temperature, humidity, dew_point, elevation. Org B cannot export Org A's trip (`403`).

A dedicated chart library was not added. An SVG path is enough for the required "chart of one sensor value" and keeps the frontend small.

### Verification completed

The following were exercised successfully:

- Login success and failure.
- Organization and User creation.
- Role/organization validation.
- User-only vehicle creation.
- Super Admin all-vehicle visibility.
- Active-trip duplicate prevention.
- Trip completion and no-active-trip response.
- Cross-tenant vehicle access rejection.
- Telemetry dropped without an active trip.
- Telemetry persisted during an active trip.
- Public MQTT broker publication reaching the API.
- Redis-to-WebSocket delivery.
- Org A live events not leaking to Org B.
- Super Admin WebSocket snapshot seeing both organizations.
- Simulator automatically reaching three vehicles.
- Simulator publishing nothing when every trip is stopped.
- Simulator publishing exactly the active vehicle when one trip is active.
- End-to-end simulator MQTT publication increasing persisted readings from 5 to 6.
- Full backend source compiling without syntax errors.
- Frontend TypeScript check completing without errors.
- Vite production build completing with zero vulnerable npm packages reported at installation.
- Browser login as an Org A User.
- Org A User seeing only three Org A vehicles.
- Browser start/stop changing trip state and returning to a clean stopped state.
- Browser login as Super Admin.
- Super Admin seeing four vehicles across Org A and Org B.
- Super Admin organization selector filtering the dashboard to Org B.
- Super Admin dashboard exposing no start/stop mutation button.
- KML parser producing a polyline of at least two points.
- On-corridor GPS measuring ~0 m from the planned route.
- Off-corridor GPS measuring ~9.7 km from the planned route.
- Multipart route upload succeeding for an Org A User on an active trip.
- In-corridor telemetry creating no Alert.
- Off-corridor telemetry creating exactly one `route_deviation` Alert.
- SMTP left unset locally: Alert persisted, email skipped with an explicit log (configure SMTP to send for real).
- Frontend TypeScript check succeeding after the route UI.
- Trip readings JSON returning tenant-scoped samples.
- CSV export returning a header plus one row per reading.
- Org B receiving `403` when requesting Org A's CSV.
- Browser history panel listing Truck A1 trips, temperature chart, Download CSV, and GPS trail overlay.

Local test accounts created during verification:

- Super Admin: `admin@example.com` / `adminpass`
- Org A User: `usera@example.com` / `usera-pass`
- Org B User: `userb@example.com` / `userb-pass`

These are local development credentials only. Production credentials and `JWT_SECRET` must be supplied through deployment environment variables.

## 3. Current project structure

### Root

- `PROJECT_HISTORY.md`: this interview-oriented engineering history. Keep it current.
- `.gitignore`: excludes credentials, virtual environments, caches, dependencies, and generated builds.
- `docker-compose.yml`: local PostgreSQL and Redis services with persistent PostgreSQL volume.
- `backend/`: FastAPI service, simulator, and Python environment.
- `frontend/`: React + TypeScript + Vite live fleet dashboard.

### Backend

- `.env`: local-only configuration defaults for database, JWT, Redis, and MQTT.
- `.env.example`: safe configuration template for onboarding and deployment.
- `requirements.txt`: reproducible Python runtime dependencies.
- `main.py`: application composition, router registration, and lifecycle startup/shutdown for MQTT and Redis.
- `database.py`: SQLAlchemy engine, session factory, declarative base, and `get_db`.
- `models.py`: relational schema and indexes.
- `schemas.py`: Pydantic v2 request/response contracts and role/org validation.
- `auth.py`: password hashing, JWT operations, login route, and authentication/role dependencies.
- `create_tables.py`: imports all models and creates tables for the no-migration development stage.
- `mqtt_ingest.py`: MQTT subscriber, payload parsing, active-trip gate, Reading persistence, Redis publication, and route-compliance hook.
- `realtime.py`: live payload format, initial snapshots, Redis subscriber, WebSocket connection registry, and per-message tenant filtering.
- `simulator.py`: three-or-more vehicle device simulator with route movement, realistic sensor variation, API trip-state checks, and MQTT publication.
- `geo.py`: KML/CSV route parsing and GPS-to-polyline distance.
- `emailer.py`: SMTP alert mail.
- `compliance.py`: deviation threshold, cooldown, Alert persistence, email, and live fan-out.

### Backend routers

- `routers/admin.py`: Super Admin organization/user provisioning.
- `routers/vehicles.py`: tenant-safe vehicle creation and listing.
- `routers/trips.py`: tenant-safe start, stop, trip history, readings, CSV export, route upload/read, and alert listing.
- `routers/ws.py`: JWT-authenticated real-time WebSocket endpoint.
- `routers/__init__.py`: marks the directory as a Python package.

### Frontend

- `package.json`: frontend dependencies and `dev`, `build`, `typecheck`, and `preview` commands.
- `vite.config.ts`: Vite React plugin configuration.
- `index.html`: application document metadata and React entry point.
- `src/main.tsx`: mounts the React application.
- `src/App.tsx`: login/session flow, dashboard composition, organization filter, status summaries, vehicle details, trip controls, and KML upload.
- `src/api.ts`: typed HTTP client, multipart route upload, and API/WebSocket environment URLs.
- `src/types.ts`: shared frontend contracts for Users, Trips, routes, alerts, and live Vehicles.
- `src/useFleetSocket.ts`: snapshot handling, reading merges, live alerts, and bounded exponential reconnect.
- `src/TripHistory.tsx`: past-trip list, temperature chart, CSV download, and trail/planned-route selection.
- `src/FleetMap.tsx`: Leaflet map, planned-route polyline, actual GPS trail, viewport fitting, status markers, and popups.
- `src/style.css`: application visual system and responsive layouts.
- `public/sample-route.kml` and `public/off-route.kml`: example planned routes for demos and tests.

## 4. Important design decisions to explain in an interview

### Why tenant ownership is stored repeatedly

`org_id` on high-volume and security-sensitive rows makes the correct tenant filter obvious, fast, and indexable. It trades a small amount of duplication for safer queries. Application code sets it from the trusted Vehicle/Trip record, never from a device payload.

### Why MQTT does not write directly to WebSockets

MQTT ingestion commits durable data, then publishes a lightweight event to Redis. Any API process can consume that event and serve its connected sockets. This supports multiple API instances and prevents a slow client from blocking ingestion.

### Why authorization is checked at query boundaries

UI hiding is not security. Every endpoint resolves the authenticated User and filters or validates ownership in the backend before reading or mutating data. WebSocket delivery applies the same rule per event.

### Why Super Admin cannot start trips

The requested behavior treats trip operation as an organization action. Super Admin has oversight and cross-organization visibility, while tenant Users control their own vehicles.

### Why telemetry is gated server-side

A simulator or physical device cannot be trusted to enforce business rules. Even if a device publishes while stopped, the API checks for an active trip before storing anything. The simulator will also avoid publishing while stopped to model normal device behavior, but the server remains the authoritative gate.

## 5. Configuration

Current environment variables:

- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_ALGORITHM`
- `ACCESS_TOKEN_EXPIRE_MINUTES`
- `REDIS_URL`
- `REDIS_CHANNEL`
- `MQTT_HOST`
- `MQTT_PORT`
- `MQTT_TOPIC`
- `MQTT_PUBLISH_TOPIC_TEMPLATE`
- Optional `MQTT_USERNAME`, `MQTT_PASSWORD`, and `MQTT_CLIENT_ID`
- `SIMULATOR_API_URL`
- `SIMULATOR_EMAIL`
- `SIMULATOR_PASSWORD`
- `SIMULATOR_VEHICLE_COUNT`
- `SIMULATOR_INTERVAL_SECONDS`
- `FRONTEND_ORIGINS`
- `ROUTE_DEVIATION_METERS`
- `ROUTE_ALERT_COOLDOWN_MINUTES`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_USE_TLS`
- `ALERT_FROM_EMAIL`

Frontend build variables:

- `VITE_API_URL` (defaults to `http://127.0.0.1:8000`)
- `VITE_WS_URL` (derived from the API URL unless explicitly set)

Local defaults exist for convenience. Deployment must override secrets and service URLs.

## 6. Remaining work

- Deploy a public URL and email reviewer logins plus this document.
- Production `JWT_SECRET` and SMTP credentials so deviation mail actually sends.
- Optional automated tests.

## 7. Known development notes

- Docker Desktop on Windows was restarted after stale Docker processes prevented startup.
- Older Uvicorn processes were stopped before loading newer MQTT/Redis code.
- Source is on GitHub at `https://github.com/harshilnayee2004/Swasemi`. Local `.env` files stay untracked.
- The Compose `version` key produces a modern Docker Compose deprecation warning but does not affect service behavior.

## 8. How to keep this document current

For every future change, add:

1. Date and feature.
2. Files added or changed.
3. Behavior introduced.
4. Reason for the design.
5. Security/tenant impact.
6. Verification performed.
7. Any known limitation or next step.
