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

Each vehicle follows a shared Gandhinagar loop (see "Navigation-style live map" below), starting at a different point along it, and emits:

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

### Navigation-style live map (Gandhinagar) — 2026-09-26

Reviewer feedback: a started trip should look like Google Maps navigation — a path that grows as the vehicle moves and stays visible when the trip stops — and the demo should be located around Gandhinagar, Gujarat.

Simulator changes (`backend/simulator.py`):

- The route is now a closed loop through Gandhinagar: Sachivalaya → Mahatma Mandir → Akshardham → Sector 28 → Indroda Nature Park → Sector 11 → back (about 10.6 km).
- Waypoints are densified to a fixed `SIMULATOR_STEP_METERS` (default 30 m) so each 2-second tick advances a realistic ~55 km/h instead of jumping between far-apart waypoints.
- All vehicles share the loop and start evenly spaced along it, so they look like a fleet on one corridor and `sample-route.kml` stays compliant for every vehicle.
- ~2 m GPS noise and an occasional held position (signal stop) make the motion plausible.
- Environmental values now sit in Gandhinagar ranges (about 33 °C, 45 % RH, 81 m elevation).

Frontend changes:

- `useFleetSocket` keeps a per-vehicle live trail keyed by trip. Readings append while the trip runs; `Stop trip` marks it ended and keeps it on screen; `Start trip` clears it. Selecting a vehicle mid-trip seeds the trail from `GET .../readings`, so a page refresh does not lose the path.
- `FleetMap` glides each marker between consecutive readings with `requestAnimationFrame` (1.8 s, matching the publish interval) and rotates a navigation arrow to the bearing of travel. Live trails are drawn as a blue line with a white casing, a green start dot, and a red end dot once the trip stops. The planned route stays green; history trails stay dashed grey.
- Follow mode pans the map to keep the selected moving vehicle in view (like turn-by-turn navigation) and switches off when the user drags the map. A `Following`/`Follow` control toggles it. The map refits only when the selection or drawn geometry changes, not on every reading — the earlier per-reading `fitBounds` made the view jump every 2 seconds.
- The vehicle card shows a trip strip with distance travelled (haversine over the trail), duration, current speed (over the last five samples), and sample count. It turns grey with "Trip ended" once the trip stops.
- `frontend/src/geo.ts` holds the haversine/bearing/summary helpers so the map and card share one implementation.
- `sample-route.kml` now matches the Gandhinagar loop; `off-route.kml` sits on the Ahmedabad riverfront (~20 km away) to trigger deviation alerts.

Basemap note: CARTO Voyager tiles were tried for a Google-Maps look but now require an API key (tiles rendered "API KEY REQUIRED"), so the map uses standard OpenStreetMap tiles. Swapping to a keyed provider is a one-line `TileLayer` change.

Starting a trip now also attaches `sample-route.kml` automatically, so the planned Gandhinagar loop appears immediately instead of waiting for a manual upload. The map chrome shows a place chip (`En route` / `Stopped` / `Trip ended` / `Gandhinagar, Gujarat`), Google-style zoom buttons, and the vehicle pin turns yellow while holding and red after stop. Follow mode turns back on when a trip starts.

The history panel is a map drawer, not a third grid column. Opening it hides the vehicle card so the two white sheets no longer stack on top of the path.

### Manual simulator deviation and named routes — 2026-09-26

There is no hardware GPS, so a live demo needed a way to send the simulated truck off the planned corridor without swapping KML files.

- `Trip.force_deviate` defaults to false. `create_tables.py` still uses `create_all`, then `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` so an existing database gets the column.
- Organization Users call `POST .../trips/{id}/deviate` and `.../deviate/reset` with the same tenant checks as start/stop. Super Admin cannot flip the flag.
- The simulator already listed trips before publishing. That poll now reads `force_deviate`. When true, it still advances along the loop but offsets each sample perpendicular to the heading by more than `ROUTE_DEVIATION_METERS`, growing each tick. `compliance.py` is unchanged: it sees a far GPS point and fires the existing Alert/email path.
- Two hardcoded named routes (Gandhinagar loop, Infocity corridor) are saved as CSV to `POST /vehicles/{id}/planned-route`. Starting a trip copies those points onto the trip `RoutePoint` rows. KML upload remains.

The vehicle card shows **Save route**, then **Start trip**, then **Deviate** / **Deviating** (red) only after a trip is running.

### User-initiated vehicles, routes, and trips — 2026-09-26

Trips were still starting themselves: leftover `active` rows kept the simulator publishing, start auto-attached a named route, and the simulator created "Simulator Vehicle N" until it had three trucks.

Organization Users can delete a vehicle from the card (`DELETE /vehicles/{id}`). Child alerts, readings, trip route points, trips, and planned-route points are removed first so foreign keys do not block the delete. Super Admin still cannot mutate vehicles.

The intended path is now the only path:

1. A User creates a vehicle by name (`POST /vehicles`).
2. They save a planned route on that vehicle (`POST /vehicles/{id}/planned-route`).
3. They start a trip. Start refuses unless at least two planned points exist, then copies them onto the trip.
4. They can click **Deviate** only while that trip is active.

The simulator lists existing vehicles and publishes only for trips the user started. It does not create vehicles and does not start trips. The vehicle card is stacked (title, 2×2 sensors, route, start/stop, deviate) so labels no longer collide with the Offline badge or the Start trip button. Deviation banners only show for the current active trip.

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
- Simulator tracking user-created vehicles only; no auto-create.
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
- Gmail delivered `Route deviation: Truck A1` to `harshilnayee2004@gmail.com`. A bounce for `usera@example.com` was expected (`example.com` does not accept mail); the mailer now skips those demo domains.
- Frontend TypeScript check succeeding after the route UI.
- Trip readings JSON returning tenant-scoped samples.
- CSV export returning a header plus one row per reading.
- Org B receiving `403` when requesting Org A's CSV.
- Browser history panel listing Truck A1 trips, temperature chart, Download CSV, and GPS trail overlay.
- Simulator publishing Gandhinagar coordinates (23.2°N, 72.6°E) for three vehicles with the densified loop (354 points).
- Browser: Truck A1 gliding along GH Road / Sector 11 with a rotated heading arrow, a growing blue trail from a green start dot, and a live strip reading 955 m · 1m 39s · 37 km/h.
- Browser: Stop trip turned the trail and arrow grey, added a red end marker, kept the path visible, showed "Trip ended · 1.1 km · 1m 54s", and the vehicle dropped to Offline after the 20 s grace period while the other two kept moving.
- Starting a trip auto-uploaded `sample-route.kml` (`POST .../trips/16/route` 200) and showed "9 points loaded" without a manual upload.
- Place chip switched from "En route · Gandhinagar" while moving to "Trip ended" after stop; zoom +/− and Follow controls stayed usable.
- Frontend TypeScript check passing after the map rework.
- `POST .../deviate` sets `force_deviate=true`; Org B receives `403` on Org A's trip.
- Named-route CSV upload uses the existing `POST .../route` parser.
- Browser: Start trip stays disabled until a planned route is saved. Created `Demo Truck`, saved Gandhinagar loop (9 points), then started the trip. Simulator stayed idle until that click, then published only Demo Truck. Deviate appeared after start and flipped to Deviating. Card layout no longer overlaps title, route, or Start trip.

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
- `routers/vehicles.py`: tenant-safe vehicle creation, listing, and delete.
- `routers/trips.py`: tenant-safe start, stop, trip history, readings, CSV export, route upload/read, and alert listing.
- `routers/ws.py`: JWT-authenticated real-time WebSocket endpoint.
- `routers/__init__.py`: marks the directory as a Python package.

### Frontend

- `package.json`: frontend dependencies and `dev`, `build`, `typecheck`, and `preview` commands.
- `vite.config.ts`: Vite React plugin configuration.
- `index.html`: application document metadata and React entry point.
- `src/main.tsx`: mounts the React application.
- `src/App.tsx`: login/session flow, dashboard composition, organization filter, status summaries, vehicle details, trip controls, live trip strip, and KML upload.
- `src/api.ts`: typed HTTP client, multipart route upload, and API/WebSocket environment URLs.
- `src/types.ts`: shared frontend contracts for Users, Trips, routes, alerts, live Vehicles, and live trails.
- `src/geo.ts`: haversine distance, bearing, trail summary (distance/duration/speed), and formatting helpers.
- `src/useFleetSocket.ts`: snapshot handling, reading merges, per-trip live trails, live alerts, and bounded exponential reconnect.
- `src/TripHistory.tsx`: past-trip list, temperature chart, CSV download, and trail/planned-route selection.
- `src/FleetMap.tsx`: Leaflet map, smooth marker animation with heading arrows, live and history trails, planned-route polyline, follow mode, and selection-based viewport fitting.
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
- Super Admin now has an in-app Platform panel: create organizations and mint invite links. A person can join only with a Super Admin link (`/?invite=...`). There is still no public signup.
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

## 9. Interview manual

Added 2026-09-26. This is the spoken walkthrough: how to start the stack, what each folder is for, what the dashboard numbers mean, and how frontend and backend share work.

### 9.1 What the product is

Swasemi is a multi-tenant fleet telemetry platform.

- An organization User sees only that organization's vehicles.
- A Super Admin sees every organization, can invite people, and cannot start or stop trips.
- There is no public signup. Join is invite-only (`/?invite=...`).
- A vehicle only stores GPS and sensor samples while a User has started a trip.
- Devices (here a Python simulator) publish over public MQTT (`broker.emqx.io`). The API writes accepted samples to PostgreSQL, publishes a live event through Redis, and the dashboard receives that event on a WebSocket.

Required story for an interviewer: **MQTT → trip gate in FastAPI → PostgreSQL + Redis → WebSocket → React map**.

### 9.2 How to start everything (Windows)

Docker Desktop must be running first. Compose only starts **PostgreSQL** and **Redis**. The API, simulator, and Vite app are local processes.

From `C:\\Projects\\Swasemi`:

```powershell
docker compose up -d
```

That maps:

| Service | Container port | Host port | Why |
| --- | --- | --- | --- |
| PostgreSQL 16 | 5432 | **5433** | Avoids clashing with a local Postgres on 5432 |
| Redis 7 | 6379 | **6379** | Pub/sub for live dashboard events |

Database name `fleet`, user/password `swasemi` / `swasemi_dev` (see `docker-compose.yml` and `backend/.env`).

**First-time backend** (from `backend/`):

```powershell
python -m venv venv
.\\venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
.\\venv\\Scripts\\python.exe create_tables.py
.\\venv\\Scripts\\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

`create_tables.py` runs SQLAlchemy `create_all` and adds `trips.force_deviate` if the table already existed. There is no Alembic in this assignment.

**Frontend** (from `frontend/`):

```powershell
npm install
npm run dev
```

Open `http://localhost:5173/`. Vite talks to `http://127.0.0.1:8000` unless `VITE_API_URL` is set.

**Simulator** (from `backend/`, after the API is up):

```powershell
$env:SIMULATOR_EMAIL='usera@example.com'
$env:SIMULATOR_PASSWORD='usera-pass'
.\\venv\\Scripts\\python.exe simulator.py
```

The simulator **does not create vehicles and does not start trips**. It lists vehicles and publishes MQTT only while a trip is `active`. If nothing is running it logs `No active trips; waiting`.

Health check: `http://127.0.0.1:8000/health` should return `{"status":"ok"}`.

### 9.3 Demo logins

| Role | Email | Password | Can do |
| --- | --- | --- | --- |
| Super Admin | `admin@example.com` | `adminpass` | See all orgs, Admin panel, invites. No start/stop/deviate. |
| Org A User | `usera@example.com` | `usera-pass` | Vehicles, routes, trips, deviate for Org A only. |
| Org B User | `userb@example.com` | `userb-pass` | Same for Org B. Gets `403` on Org A. |

`admin@astermedcare.com` is not seeded. These passwords are local only.

### 9.4 Operator path (what you demo)

1. Sign in as an organization User.
2. Name a vehicle in the sidebar and click **Add** (`POST /vehicles`). **Delete vehicle** on the card removes that truck and its trips/readings (`DELETE /vehicles/{id}`). Only organization Users can delete, and only their own org.
3. On the card: pick a named route or **Upload KML**, then **Save route** (`POST /vehicles/{id}/planned-route`). Points sit on `vehicle_route_points` until a trip starts.
4. **Start trip** stays disabled until at least two planned points exist. Start copies those points onto trip `route_points` (`POST /vehicles/{id}/trips/start`).
5. The simulator then publishes GPS + temperature/humidity/dew point/elevation on `swasemi/fleet/{device_id}/readings`.
6. **Deviate** (`POST .../trips/{id}/deviate`) sets `Trip.force_deviate`. The simulator offsets GPS sideways past the 200 m limit so `compliance.py` can create an Alert and email.
7. **Stop trip** completes the trip. Ingest drops further MQTT samples for that vehicle.

Super Admin never sees Add / Save route / Start / Deviate.

### 9.5 Folders and who owns what

| Path | Meaning |
| --- | --- |
| `docker-compose.yml` | Local Postgres + Redis only |
| `PROJECT_HISTORY.md` | This file: history + interview notes |
| `backend/main.py` | FastAPI app, CORS, MQTT + Redis lifespan |
| `backend/database.py` | Engine, `SessionLocal`, `get_db` |
| `backend/models.py` | Org, User, Invite, Vehicle, VehicleRoutePoint, Trip, Reading, RoutePoint, Alert |
| `backend/schemas.py` | Pydantic v2 I/O |
| `backend/auth.py` | Login, JWT (`sub`, `role`, `org_id`), `/auth/join` |
| `backend/create_tables.py` | `create_all` + `force_deviate` ALTER |
| `backend/mqtt_ingest.py` | Subscribe, parse, **active-trip gate**, persist Reading, Redis publish, compliance |
| `backend/realtime.py` | Snapshot + reading/alert payloads, Redis fan-out, tenant filter on WS |
| `backend/compliance.py` | Distance from GPS to planned polyline; Alert + SMTP |
| `backend/geo.py` | KML/CSV parse, haversine, **distance-to-route** (backend) |
| `backend/emailer.py` | SMTP; skips `@example.com` / localhost |
| `backend/simulator.py` | Fake trucks on a Gandhinagar loop; offset when `force_deviate` |
| `backend/routers/vehicles.py` | Create/list/delete + planned-route GET/POST |
| `backend/routers/trips.py` | Start/stop, deviate, history, readings, CSV, trip route |
| `backend/routers/admin.py` | Orgs, users, invites |
| `backend/routers/ws.py` | `ws://.../ws?token=` |
| `frontend/src/App.tsx` | Login, dashboard, create vehicle, save route, start/stop, deviate, card UI |
| `frontend/src/api.ts` | HTTP client |
| `frontend/src/useFleetSocket.ts` | Live vehicles, trails, alerts, reconnect |
| `frontend/src/FleetMap.tsx` | Leaflet, trail, planned route, **Follow** |
| `frontend/src/geo.ts` | **Trip distance / duration / speed** (frontend) |
| `frontend/src/namedRoutes.ts` | Gandhinagar loop + Infocity corridor as CSV |
| `frontend/src/TripHistory.tsx` | Past trips, temp chart, CSV download |
| `frontend/src/SuperAdmin.tsx` | Invite panel |
| `frontend/public/sample-route.kml` | Example planned corridor |
| `frontend/public/off-route.kml` | Far-away Ahmedabad line (old demo file) |

Two different “distance” implementations live in two `geo` files. Do not mix them up in an interview.

### 9.6 The four sensor blocks (top of the vehicle card)

These are the last MQTT reading for that vehicle, stored on `readings` and shown live.

| Block | Field | Meaning |
| --- | --- | --- |
| Temperature | `temperature` | °C from the device (simulator: ~30–36 °C) |
| Humidity | `humidity` | Relative humidity % |
| Dew point | `dew_point` | Simulator uses a simple approximation from T and humidity |
| Elevation | `elevation` | Metres above sea level (Gandhinagar ~80 m) |

They are **not** trip statistics. A stopped vehicle can still show the last sample until it ages out. **Online** means `last_seen` is within 20 seconds (`ONLINE_GRACE_MS` in `App.tsx`). After that the badge is Offline even if old numbers remain.

### 9.7 The four trip blocks (blue strip)

These appear after a live trail has at least two GPS points. Computed only on the frontend in `frontend/src/geo.ts` → `summarizeTrail`. They are **not** stored as their own columns.

| Block | Meaning | How it is calculated |
| --- | --- | --- |
| **Distance** | How far the truck has actually driven on this trip | Sum of haversine (great-circle) metres between consecutive trail points. Shown as `m` or `km`. |
| **Duration** | How long the trip has been recording | Last point timestamp minus first point timestamp. |
| **Speed** | Instant-ish speed, not average for the whole trip | Haversine over the **last five** points, converted to km/h. Below ~4 km/h the UI says the trip is active but stopped (traffic light). |
| **Samples** | How many GPS points are in the live trail buffer | Count of points (capped around 4000 in the socket hook). |

**Distance (blue strip) is path length.** It answers “how far did we drive?”

**Deviation metres (pink banner) is a different number.** Backend `distance_to_route_m` in `backend/geo.py` measures how far the *current* GPS is from the nearest segment of the **planned** polyline. If that is over `ROUTE_DEVIATION_METERS` (default **200 m**) and the 10-minute cooldown has passed, `compliance.py` writes an `Alert` and may email org users. That is “how far off the planned road?”, not “how far have we travelled?”

### 9.8 Follow / Following (map only, no backend)

File: `frontend/src/FleetMap.tsx`. There is no API for this.

- State is a boolean `follow`, default `true`.
- The button label is **Following** when on, **Follow** when off.
- While Following, if the selected vehicle has an **active** trip, the map pans so the marker stays in view (`FollowVehicle` + `panTo`).
- Dragging the map turns follow **off** (`dragstart` → `setFollow(false)`). That is “unfollow”.
- Starting or stopping a trip changes `followToken` in `App.tsx` (`vehicleId-tripId`), which turns follow **back on**.
- Zoom +/− never talks to the server.

Interview line: “Follow is a camera mode on the Leaflet map. Telemetry does not depend on it.”

### 9.9 Map colours (say this if they ask)

- Thick **green** line: planned route (`route_points` or saved planned points).
- **Blue** line with white casing: live GPS trail for the current trip. Grey if the trip ended.
- Green dot: trip start. Red dot: trip end after stop.
- Dashed grey: a historical trip selected in the history drawer.
- Pin: blue moving, yellow holding, grey offline, red after trip ended.

### 9.10 Backend path of one reading

1. Simulator (or a real device) publishes JSON to `swasemi/fleet/{device_id}/readings`.
2. `mqtt_ingest.py` looks up the vehicle by `device_id`.
3. If there is no `Trip` with `status=active` for that vehicle, the message is dropped. **Server is the gate.**
4. Otherwise a `Reading` row is written (`trip_id`, `vehicle_id`, `org_id` copied from the vehicle/trip, never from the payload).
5. `evaluate_route_compliance` may create an `Alert`.
6. `publish_telemetry` sends a JSON event on Redis channel `fleet:telemetry`.
7. `redis_fanout_loop` in `realtime.py` broadcasts to WebSocket clients whose JWT `org_id` matches (or Super Admin).
8. `useFleetSocket` merges the reading into the vehicle list and appends a trail point.

JWT is a Bearer header on HTTP and `?token=` on the WebSocket. Claims: `sub`, `role`, `org_id`.

### 9.11 Roles in one sentence each

- **User**: scoped to one `org_id`. Create vehicles, save planned routes, start/stop, deviate, see history/CSV for that org.
- **Super Admin**: `org_id` is null. Sees all snapshots, creates orgs and invite links. Cannot operate trips.

### 9.12 One-minute verbal script

“Users belong to an org; Super Admin does not. Invite only. I create a vehicle, save a planned route, then start a trip. MQTT samples are stored only while that trip is active. Live UI is Redis to WebSocket. Distance on the blue strip is the sum of GPS hops. The deviation email uses a different distance: metres off the planned polyline, 200 m limit. Follow just keeps the map camera on the truck. Super Admin can watch but cannot start the truck.”
