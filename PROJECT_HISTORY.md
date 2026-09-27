# Fleet Telemetry Platform — Build History and Interview Notes

This document is the running engineering record for the assignment. Update it whenever the project changes. It explains what exists, why each decision was made, how data moves through the system, and what remains.

## 1.3 Deviation email on Deviate click (2026-09-27)

- Clicking **Deviate** now creates a route-deviation alert and sends mail immediately. The GPS offset still runs on the next simulator ticks.
- Demo `@example.com` org users no longer silently drop mail: `ALERT_TO_EMAIL`, then `ALERT_FROM_EMAIL` / SMTP username, is used as the inbox.
- The dashboard reports who was emailed, or tells you SMTP is missing on the host.

## 1.2 UI/UX polish completed on 2026-09-27

- Unified dashboard surfaces, action colors, spacing, borders, hover states, and overflow handling across the fleet sidebar, live map card, trip history, and Admin Console.
- Added visible fleet loading skeletons, trip-history and reading loaders, clear empty states, a reconnecting banner, a selected-vehicle map cue, and a prominently surfaced route-deviation alert.
- Added in-flight labels, disabled controls, dismissible inline errors, and brief success confirmations for dashboard and Admin Console actions without changing API calls, WebSocket behavior, or tenant/auth logic.
- Checked the login layout at `1366x768` and added compact-height dashboard rules to preserve a clean laptop-sized review experience. The optional component refactor remains intentionally deferred.

### Route corridor refinement

- Replaced the coarse demo route chords with detailed street-grid corridor points for the Gandhinagar loop and Infocity corridor. The simulator and the bundled Gandhinagar KML use the same loop, so planned-route and live-trail geometry remain aligned.
- Updated the map overlays with a white road-safe casing and green route markers for the planned route, plus a higher-contrast blue live-trail stroke and subtle trail halo.

## 1.1 Audit remediation completed on 2026-09-27

- Changed `start-all.ps1` to start only the Postgres and Redis Compose services; the local API, Vite app, and simulator continue to run in their own local processes. `docker compose up --build -d` remains the separate full-stack demo mode.
- Removed seeded active trips. Fresh demo data contains the two demo vehicles but requires an operator to save a route and start a trip before telemetry is persisted.
- Made database initialization fail startup instead of being logged and ignored. `/health` now checks both PostgreSQL and Redis and returns `503` with dependency status when either is unavailable.
- Removed the Docker-only Nginx backend proxy. The frontend is configured exclusively with build-time `VITE_API_URL` and `VITE_WS_URL`, which supports a separately deployed frontend and API.
- Kept the intentional non-deliverable demo email-domain filter and added a clear route-compliance warning when every organization recipient is filtered.
- Renamed the simulator spacing setting to `SIMULATOR_POSITION_SPREAD`, documented all runtime settings in `.env.example`, removed unused schema/frontend wrappers, and made demo password hints explicit opt-in through `EXPOSE_DEMO_PASSWORD_HINTS`.
- Added non-development JWT-secret enforcement, pinned backend dependencies, line-ending attributes, and an eight-test pytest suite covering login, tenant isolation, trip prerequisites, ingestion, and route alerts.
- SMTP credential rotation is intentionally not automated: a new Gmail App Password must be generated in the Gmail account and placed only in the ignored local `backend/.env` file. No credential was read, copied, or committed during this remediation.
- Skipped the optional Dashboard component split because it is cosmetic and risks the live demo close to deployment. Production-only MQTT ACLs, WebSocket re-authentication, JWT revocation, and upload limits remain intentionally deferred for the interview demo.

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
- The map refits only when the selection or drawn geometry changes, not on every reading — eliminating jumpy map renders. Unnecessary UI overlays (such as the redundant Following toggle button) and unused sample assets (`off-route.kml`) were removed to keep the interface and codebase clean and lean.
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

## 6. Changes on 2026-09-27

### One-click Windows launcher

Added two files to the project root so local development starts with a single double-click instead of four manual terminals:

- `start-all.bat`: A wrapper batch file that calls `start-all.ps1` with `-ExecutionPolicy Bypass`, allowing double-click execution without changing system PowerShell policy.
- `start-all.ps1`: Orchestration script that runs in order:
  1. Kills any stale Swasemi backend or simulator processes from a previous run.
  2. Runs `docker compose up -d` to start PostgreSQL (port 5433) and Redis (port 6379).
  3. Opens a new titled PowerShell window running `uvicorn main:app --host 127.0.0.1 --port 8000` from inside the venv.
  4. Polls `http://127.0.0.1:8000/health` every second (30 s timeout) before proceeding. If the health check fails it prints a clear message explaining the likely port conflict with another Docker container (`cctv_backend`) and exits without launching the simulator against a dead backend.
  5. Opens a new titled window running `npm run dev` from `frontend/`.
  6. Opens a new titled window running `simulator.py` (see below). If the simulator crashes the window stays open displaying the error instead of silently closing.

Files added: `start-all.bat`, `start-all.ps1`.

Why: Eliminates the four-terminal startup ceremony so any reviewer or developer can start the full stack in one step after opening Docker Desktop.

Security/tenant impact: None. The launcher contains only development credentials that already exist in `.env`.

### Simulator extended to all organisations (Super Admin mode)

**Problem identified:** The simulator was hardcoded to log in as a single organisation User (`usera@example.com`). When a new user from a different organisation (e.g. `rujukhayekaju@gmail.com`, Org 3) created a vehicle and started a trip, the simulator never saw it because `GET /vehicles` scopes results to the caller's organisation. Telemetry was never published, so the vehicle showed Offline, sensor readings showed `—`, and route-deviation emails were never triggered.

**Root cause in code:** `simulator.py` line 239 contained an explicit guard: `"Super Admin credentials cannot operate vehicles."` — this error message was misleading because Super Admin does not need to start/stop trips, it only needs to call `GET /vehicles` (which already returns all vehicles for Super Admin) and `GET /vehicles/{id}/trips` (also unrestricted for Super Admin).

**Fix:**

- `backend/simulator.py`: Removed the Super Admin restriction block in `run()`. The simulator now accepts any valid credentials including `super_admin`. Updated the startup log message to `"Simulator started — watching ALL vehicles across all organizations"`.
- `start-all.ps1`: Changed `SIMULATOR_EMAIL` from `usera@example.com` to `admin@example.com` and `SIMULATOR_PASSWORD` to `adminpass`.
- `backend/.env`: Updated `SIMULATOR_EMAIL` and `SIMULATOR_PASSWORD` defaults to the Super Admin account so manual runs (`python simulator.py`) also work without extra environment variable exports.

**Behaviour after fix:** One simulator instance logs in as Super Admin, calls `GET /vehicles` to get every vehicle across all organisations, then for each vehicle calls `GET /vehicles/{id}/trips` to find its active trip. If a trip is active it publishes MQTT telemetry for that vehicle. Adding a new user in any organisation, creating a vehicle, and starting a trip is sufficient — the simulator picks it up within the next 2-second tick automatically, with no restart or extra command needed.

Files changed: `backend/simulator.py`, `start-all.ps1`, `backend/.env`.

Security/tenant impact: The simulator uses Super Admin credentials only to read vehicle and trip state over the internal loopback API. It does not start, stop, or mutate trips. The MQTT publish path is unchanged: `mqtt_ingest.py` still validates `device_id` and enforces the active-trip gate on the server side regardless of what the simulator sends.

Verification:
- Super Admin login via API returns token.
- `GET /vehicles` with Super Admin token returns all vehicles across Org A, Org B, and Org 3 (Raju).
- Simulator published `kaju` telemetry (Org 3) at Gandhinagar coordinates within 2 seconds of startup.
- Vehicle card showed live temperature, humidity, dew point, and elevation after first MQTT publish.
- `kaju` truck began moving on the Leaflet map.
- Second vehicle `s` (Org A) continued to receive telemetry in the same simulator run.

## 7. Work completed on 2026-09-27

### Full Stack Dockerization & Production Deployment Strategy
- Created `backend/Dockerfile` using Python 3.12-slim and Uvicorn.
- Created `frontend/Dockerfile` (multi-stage Node 20 build + Nginx static server) and `frontend/nginx.conf` with reverse proxy rules for API routes (`/auth`, `/vehicles`, `/admin`, `/health`) and WebSocket upgrades (`/ws`).
- Integrated automated `simulator` worker service into `docker-compose.yml` (`command: python simulator.py`, `restart: always`).
- Single-command full deployment: `docker compose up --build -d` provisions Database, Redis, Backend, Frontend Nginx, and automated Telemetry Simulator automatically.
- Added database auto-initialization (`init_db()` in `create_tables.py`) called on FastAPI `lifespan` startup to seed Super Admin, Org A, Org B, demo vehicles, and active trips on fresh deployments.

### Enhanced Super Admin Console & User Management
- Created `GET /admin/stats` returning platform metrics (`total_users`, `total_organizations`, `total_vehicles`, `total_active_trips`, `total_readings`).
- Created `GET /admin/users` returning all system users with role badges, assigned organization names, and timestamps.
- Added `DELETE /admin/organizations/{org_id}` for removing tenant organizations and cleaning up child data.
- Added `DELETE /admin/invites/{invite_id}` for revoking pending invite links.
- Updated `SuperAdmin.tsx` with:
  1. Live KPI metrics cards.
  2. Searchable user table with live email/org/role filtering.
  3. Action buttons for deleting users with self-deletion protection.
  4. Direct account creation for standard users or Super Admins.
  5. Organization management and invite link revocation.

---

## 8. Known development notes

- Docker Desktop on Windows was restarted after stale Docker processes prevented startup.
- Older Uvicorn processes were stopped before loading newer MQTT/Redis code.
- A second Uvicorn process (system Python, not venv) was found running on port 8000 alongside the correct venv process. The stale process was killed; `start-all.ps1` now explicitly kills any Swasemi venv uvicorn before restarting.
- The `cctv_backend` Docker container on the same machine also binds port 8000. If it is running when `start-all.bat` is launched, the health check will fail and the script will print `docker stop cctv_backend` as the corrective action.
- Source is on GitHub at `https://github.com/harshilnayee2004/Swasemi`. Local `.env` files stay untracked.
- The Compose `version` key produces a modern Docker Compose deprecation warning but does not affect service behavior.

---

## 9. Interview manual

Added 2026-09-26 (Updated 2026-09-27). This is your comprehensive spoken walkthrough: how to start the stack, how the architecture works, what the numbers mean, and how frontend and backend share work.

### 9.1 What the product is

Swasemi is a multi-tenant fleet telemetry platform.

- An organization User sees only that organization's vehicles.
- A Super Admin sees every organization, views platform analytics, manages users/orgs/invites, and cannot start or stop trips.
- There is no public signup. Join is invite-only (`/?invite=...`).
- A vehicle only stores GPS and sensor samples while a User has started a trip.
- Simulated devices can still publish over public MQTT (`broker.emqx.io`). On Vercel/Render there is no separate simulator process: **Start simulator** on the dashboard runs the same GPS loop inside the API and feeds `ingest_telemetry`, so the map streams without a laptop running `simulator.py`.

Required story for an interviewer: **MQTT → active trip gate in FastAPI → PostgreSQL + Redis → WebSocket → React map**.

### 9.2 How to start everything

#### Option A: One-Command Production Docker Deployment
```bash
docker compose up --build -d
```
Starts all 5 services: PostgreSQL (5433), Redis (6379), Backend (8000), Telemetry Simulator Worker, and Frontend (80/5173).

#### Option B: Local Windows Development Launcher
From `C:\Projects\Swasemi`:
```powershell
.\start-all.ps1
```

### 9.3 Demo logins

| Role | Email | Password | Can do |
| --- | --- | --- | --- |
| **Super Admin** | `admin@example.com` | `adminpass` | See all orgs, KPI stats, search/delete users, create/delete orgs, revoke invites. |
| **Org A User** | `usera@example.com` | `usera-pass` | Vehicles, routes, trips, deviate for Org A only. |
| **Org B User** | `userb@example.com` | `userb-pass` | Same for Org B. Gets `403` on Org A. |

### 9.4 Operator path (what you demo in an interview)

1. **Sign in as an organization User** (`usera@example.com`).
2. **Add a vehicle** in the sidebar (`POST /vehicles`). **Delete vehicle** on the card removes that truck and its trips/readings (`DELETE /vehicles/{id}`).
3. **Save route**: Pick a named route or **Upload KML**, then click **Save route** (`POST /vehicles/{id}/planned-route`).
4. **Start trip**: Starts trip (`POST /vehicles/{id}/trips/start`).
5. **Telemetry streaming**: The simulator immediately starts publishing GPS + temperature/humidity/dew point/elevation on `swasemi/fleet/{device_id}/readings`.
6. **Deviate**: Click **Deviate** (`POST .../trips/{id}/deviate`). The simulator offsets GPS sideways past 200 m limit so `compliance.py` creates an Alert and email.
7. **Stop trip**: Completes the trip. Ingest drops further MQTT samples for that vehicle.
8. **Switch to Super Admin**: Sign in as `admin@example.com`. View live KPI platform metrics, filter users, delete accounts, manage orgs, and observe all fleets across the map simultaneously.

### 9.5 Folders and file responsibilities

| Path | Meaning |
| --- | --- |
| `docker-compose.yml` | Full containerized stack (Postgres, Redis, Backend, Simulator, Frontend) |
| `PROJECT_HISTORY.md` | History + comprehensive interview manual |
| `backend/Dockerfile` | Production Python 3.12 image for FastAPI |
| `frontend/Dockerfile` | Production multi-stage build + Nginx reverse proxy |
| `frontend/nginx.conf` | Reverse proxy for API (`/auth`, `/vehicles`, `/admin`) and WebSocket (`/ws`) |
| `backend/main.py` | FastAPI app, CORS, `init_db()` on lifespan, MQTT + Redis lifespan |
| `backend/database.py` | Engine, `SessionLocal`, `get_db` |
| `backend/models.py` | Org, User, Invite, Vehicle, VehicleRoutePoint, Trip, Reading, RoutePoint, Alert |
| `backend/schemas.py` | Pydantic v2 I/O, UserWithOrgOut, PlatformStatsOut |
| `backend/auth.py` | Login, JWT (`sub`, `role`, `org_id`), `/auth/join` |
| `backend/create_tables.py` | `create_all`, `force_deviate` ALTER, and `init_db` auto-seed |
| `backend/mqtt_ingest.py` | Subscribe, parse, **active-trip gate**, persist Reading, Redis publish, compliance |
| `backend/realtime.py` | Snapshot + reading/alert payloads, Redis fan-out, tenant filter on WS |
| `backend/compliance.py` | Distance from GPS to planned polyline; Alert + SMTP |
| `backend/geo.py` | KML/CSV parse, haversine, **distance-to-route** (backend) |
| `backend/emailer.py` | SMTP; skips `@example.com` / localhost |
| `backend/simulator.py` | Telemetry simulator on a Gandhinagar loop; offset when `force_deviate` |
| `backend/routers/vehicles.py` | Create/list/delete + planned-route GET/POST |
| `backend/routers/trips.py` | Start/stop, deviate, history, readings, CSV, trip route |
| `backend/routers/admin.py` | Orgs, users, invites, platform stats, user deletion |
| `backend/routers/ws.py` | `ws://.../ws?token=` |
| `frontend/src/App.tsx` | Login, dashboard, create vehicle, save route, start/stop, deviate, card UI |
| `frontend/src/api.ts` | HTTP client (stats, users, orgs, invites, vehicles, trips) |
| `frontend/src/useFleetSocket.ts` | Live vehicles, trails, alerts, reconnect |
| `frontend/src/FleetMap.tsx` | Leaflet, trail, planned route, **Follow** |
| `frontend/src/geo.ts` | **Trip distance / duration / speed** (frontend) |
| `frontend/src/SuperAdmin.tsx` | Super Admin console (KPI stats, user search, delete user, orgs, invites) |

### 9.6 Sensor blocks vs Trip statistics

- **Sensor Blocks** (top of card): Last received MQTT reading (`temperature`, `humidity`, `dew_point`, `elevation`).
- **Trip Statistics** (blue strip): Computed on the frontend in `frontend/src/geo.ts` (`summarizeTrail`).
  - **Distance**: Cumulative haversine sum between consecutive GPS points.
  - **Duration**: Timestamp difference between last and first point.
  - **Speed**: Rolling speed over last 5 points in km/h.

---

## 10. Technical Interview Q&A Deep Dive

Use this section to prepare for technical interview questions about Swasemi's architecture, choices, security, and scaling.

### Q1: Can you explain the end-to-end data flow when a vehicle sends a location update?
> **Answer**: 
> 1. An IoT device (or our simulator) publishes a JSON payload over MQTT to `swasemi/fleet/{device_id}/readings`.
> 2. The FastAPI backend listens on MQTT via `mqtt_ingest.py`. It resolves the vehicle by `device_id` and checks if there is an active trip (`status='active'`).
> 3. If there is no active trip, the message is **dropped at the server gate**.
> 4. If active, the reading is stored in PostgreSQL as a `Reading` record (with `org_id` inherited from the vehicle's tenant).
> 5. Route compliance is evaluated in `compliance.py` by measuring the shortest perpendicular distance to the planned route polyline. If >200 m, an `Alert` is generated and emailed.
> 6. The reading is published to Redis Pub/Sub channel `fleet:telemetry`.
> 7. The async `redis_fanout_loop` in `realtime.py` receives the event and broadcasts it over WebSockets (`ws://.../ws?token=...`) to connected dashboard clients. Tenant authorization is enforced before pushing data over each client's WebSocket.

### Q2: How did you implement multi-tenancy and data isolation?
> **Answer**: 
> Multi-tenancy is enforced at both database and API middleware levels:
> - Every tenant belongs to an `Organization`. Models (`User`, `Vehicle`, `Trip`, `Reading`, `Alert`) store `org_id`.
> - `org_id` is intentionally denormalized onto child records so tenant queries do not require multi-table joins.
> - JWT tokens embed `sub` (User ID), `role`, and `org_id`.
> - Every API endpoint validates tenant ownership. Guessed IDs across tenants return `403 Forbidden`.
> - WebSocket streams filter events dynamically per connection: Standard users receive events matching their `org_id`, while Super Admins receive all events.

### Q3: Why did you separate MQTT ingestion from WebSocket delivery using Redis?
> **Answer**: 
> Decoupling is essential for high-throughput IoT systems:
> - Directing MQTT messages straight to WebSockets would tie telemetry ingestion to slow frontend consumers, leading to backpressure and dropped packets.
> - By using Redis Pub/Sub as an in-memory event bus, MQTT ingestion stays fast and non-blocking.
> - Redis enables horizontal scaling: multiple FastAPI worker instances can subscribe to Redis and push WebSocket updates to thousands of connected dashboard clients independently.

### Q4: How does the active-trip gate work, and why is it enforced on the server side?
> **Answer**: 
> A vehicle only records data when a trip is active (`Trip.status == 'active'`). 
> Although the simulator is coded not to send data when stopped, we enforce the trip gate in `mqtt_ingest.py` on the server. If an unknown or stopped vehicle attempts to send data, FastAPI drops it immediately. This prevents database bloat, saves storage costs, and protects against compromised or misconfigured IoT hardware.

### Q5: How do you handle route deviation and alerts?
> **Answer**: 
> When a planned route (KML or CSV) is saved, we store ordered `RoutePoint` coordinates.
> On every accepted GPS reading, `compliance.py` uses `geo.py` to calculate the shortest distance from the GPS point to every segment of the planned polyline using haversine and vector projections.
> If the distance exceeds `ROUTE_DEVIATION_METERS` (default 200 m), an `Alert` record is generated, an alert event is published to Redis/WebSocket, and an email notification is dispatched via `emailer.py` with a 10-minute cooldown to prevent spamming.

### Q6: How is Super Admin authorization designed?
> **Answer**: 
> Super Admins have `org_id = null` and role `super_admin`.
> - They have global read access across all organizations and vehicles.
> - They access the Super Admin Console (`SuperAdmin.tsx`) to view platform analytics (`GET /admin/stats`), list/search all users (`GET /admin/users`), delete accounts (`DELETE /admin/users/{id}`), manage organizations (`POST/DELETE /admin/organizations`), and manage invite links.
> - **Operational Boundary**: Super Admins cannot start or stop vehicle trips—only tenant organization users can operate their fleet's vehicles.

### Q7: Why did you use WebSockets instead of HTTP Polling for live telemetry?
> **Answer**: 
> Telemetry requires sub-second updates for live vehicle tracking.
> - HTTP Polling causes massive server overhead (thousands of HTTP handshakes per minute) and high latency.
> - WebSockets establish a single persistent TCP connection. After authentication, telemetry events are pushed instantly (latency <50ms) from server to client with minimal overhead.

### Q8: How does the application handle Docker deployment in production?
> **Answer**: 
> We containerized the entire stack using Docker and Docker Compose:
> - **Backend**: Containerized with Python 3.12-slim and Uvicorn.
> - **Frontend**: Multi-stage Docker build (Node 20 compiling Vite React → Nginx alpine serving static assets & reverse proxying `/api` and `/ws`).
> - **Telemetry Simulator**: Dedicated worker container (`command: python simulator.py`, `restart: always`).
> - **PostgreSQL & Redis**: Managed database and pub/sub cache containers.
> Running `docker compose up --build -d` brings up all 5 services automatically, and FastAPI `lifespan` automatically runs database migrations and seeds initial accounts.

### Q9: How would you scale this application to handle 100,000 active vehicles?
> **Answer**: 
> To scale to 100,000+ vehicles:
> 1. **MQTT Broker Clustering**: Replace single public EMQX broker with a clustered EMQX/Mosquitto deployment behind a Network Load Balancer.
> 2. **Ingestion Workers**: Run stateless `mqtt_ingest` workers as a separate microservice consumer group reading from Kafka or RabbitMQ instead of direct MQTT handlers.
> 3. **TimescaleDB / Postgres Partitioning**: Use TimescaleDB extension or table partitioning by `(org_id, timestamp)` to optimize time-series SQL writes and queries.
> 4. **Redis Sentinel / Cluster**: Scale Redis for pub/sub and caching.
> 5. **CDN & Frontend Caching**: Serve static React assets via CDN (Cloudflare/AWS CloudFront).

### Q10: What is your 1-minute elevator pitch for this project in an interview?
> **"Swasemi is a multi-tenant fleet telemetry platform built with FastAPI, PostgreSQL, Redis, MQTT, and React. Devices stream GPS and environmental data over MQTT, which FastAPI validates against an active-trip gate and stores in PostgreSQL. Live events are published via Redis Pub/Sub and pushed to dashboard Leaflet maps over WebSockets. It features strict tenant data isolation, route deviation detection with automated email alerts, an automated telemetry simulator, and a Super Admin console with platform analytics and user management. The entire stack is containerized with Docker Compose for one-command deployment."**


