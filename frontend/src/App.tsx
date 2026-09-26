import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import {
  createVehicle,
  deleteVehicle,
  getAlerts,
  getCurrentUser,
  getPlannedRoute,
  getReadings,
  getRoute,
  listTrips,
  listVehicles,
  login,
  savePlannedRoute,
  setTripDeviate,
  startTrip,
  stopTrip,
} from './api'
import { FleetMap } from './FleetMap'
import { formatDistance, formatDuration, summarizeTrail } from './geo'
import { JoinScreen } from './JoinScreen'
import { NAMED_ROUTES, routeToCsv } from './namedRoutes'
import { SuperAdmin } from './SuperAdmin'
import { TripHistory } from './TripHistory'
import type { CurrentUser, LiveVehicle, Reading, RoutePoint, VehicleRecord } from './types'
import { useFleetSocket } from './useFleetSocket'

const TOKEN_KEY = 'fleet_access_token'
const ONLINE_GRACE_MS = 20_000
const CLOCK_TICK_MS = 2_000

function formatSensor(value: number | null, suffix: string) {
  return value === null ? '—' : `${value.toFixed(1)}${suffix}`
}

function formatLastSeen(lastSeen: string | null, now: number) {
  if (!lastSeen) return 'No readings yet'
  const seconds = Math.max(0, Math.floor((now - new Date(lastSeen).getTime()) / 1000))
  if (seconds < 5) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

function vehicleFromRecord(record: VehicleRecord): LiveVehicle {
  return {
    vehicle_id: record.id,
    device_id: record.device_id,
    name: record.name,
    org_id: record.org_id,
    org_name: record.org_name,
    trip_id: null,
    last_seen: null,
    temperature: null,
    humidity: null,
    dew_point: null,
    elevation: null,
    latitude: null,
    longitude: null,
  }
}

const DEMO_LOGINS = [
  { label: 'Org A user', email: 'usera@example.com', password: 'usera-pass' },
  { label: 'Super Admin', email: 'admin@example.com', password: 'adminpass' },
] as const

function LoginScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: CurrentUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await login(email, password)
      const user = await getCurrentUser(result.access_token)
      localStorage.setItem(TOKEN_KEY, result.access_token)
      onAuthenticated(result.access_token, user)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand brand-light">
          <span className="brand-mark">S</span>
          <span>Swasemi Fleet</span>
        </div>
        <div className="story-copy">
          <p className="eyebrow">Fleet intelligence, in motion</p>
          <h1>Every vehicle.<br />One live picture.</h1>
          <p>
            Monitor location, environmental conditions, and trip activity across your fleet in real time.
          </p>
        </div>
        <div className="signal-card">
          <span className="pulse" />
          <div>
            <strong>Live telemetry</strong>
            <small>MQTT → PostgreSQL → Redis → WebSocket</small>
          </div>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div>
            <p className="eyebrow dark">Invite-only access</p>
            <h2>Welcome back</h2>
            <p className="muted">Use a seeded demo account. There is no public signup.</p>
          </div>

          <label>
            Email address
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="usera@example.com"
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
            <span className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="usera-pass"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="password-view"
                onClick={() => setShowPassword((open) => !open)}
                aria-label={showPassword ? 'Hide password' : 'View password'}
              >
                {showPassword ? 'Hide' : 'View'}
              </button>
            </span>
          </label>

          {error && (
            <div className="form-error">
              {error}
              {error.toLowerCase().includes('invalid') && (
                <small> Use usera@example.com / usera-pass — not an Aster Medcare email.</small>
              )}
            </div>
          )}
          <div className="demo-logins">
            {DEMO_LOGINS.map((account) => (
              <button
                key={account.email}
                type="button"
                className="demo-login"
                onClick={() => {
                  setEmail(account.email)
                  setPassword(account.password)
                  setError('')
                }}
              >
                {account.label}
              </button>
            ))}
          </div>
          <button type="submit" className="primary-button" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}

interface DashboardProps {
  token: string
  user: CurrentUser
  onLogout: () => void
}

function Dashboard({ token, user, onLogout }: DashboardProps) {
  const { vehicles, alerts, trails, connection, updateTrip, seedTrail, setAlerts, addVehicle, removeVehicle } = useFleetSocket(token)
  const [selectedOrg, setSelectedOrg] = useState<number | 'all'>('all')
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null)
  const [tripBusy, setTripBusy] = useState<number | null>(null)
  const [actionError, setActionError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [route, setRoute] = useState<RoutePoint[]>([])
  const [plannedCount, setPlannedCount] = useState(0)
  const [routeBusy, setRouteBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [namedRouteId, setNamedRouteId] = useState(NAMED_ROUTES[0].id)
  const [forceDeviate, setForceDeviate] = useState(false)
  const [deviateBusy, setDeviateBusy] = useState(false)
  const [newVehicleName, setNewVehicleName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [trail, setTrail] = useState<Reading[]>([])
  const [historyRoute, setHistoryRoute] = useState<RoutePoint[]>([])

  const handleHistoryTrip = useCallback((nextTrail: Reading[], planned: RoutePoint[]) => {
    setTrail(nextTrail)
    setHistoryRoute(planned)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    listVehicles(token)
      .then((records) => records.forEach((record) => addVehicle(vehicleFromRecord(record))))
      .catch(() => undefined)
  }, [token, addVehicle])

  const organizations = useMemo(() => {
    const byId = new Map<number, string>()
    vehicles.forEach((vehicle) =>
      byId.set(vehicle.org_id, vehicle.org_name ?? `Organization ${vehicle.org_id}`),
    )
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [vehicles])

  const visibleVehicles = useMemo(
    () =>
      selectedOrg === 'all'
        ? vehicles
        : vehicles.filter((vehicle) => vehicle.org_id === selectedOrg),
    [selectedOrg, vehicles],
  )

  useEffect(() => {
    if (
      selectedVehicleId === null ||
      !visibleVehicles.some((vehicle) => vehicle.vehicle_id === selectedVehicleId)
    ) {
      setSelectedVehicleId(visibleVehicles[0]?.vehicle_id ?? null)
    }
  }, [selectedVehicleId, visibleVehicles])

  const isOnline = (vehicle: LiveVehicle) =>
    vehicle.last_seen !== null &&
    now - new Date(vehicle.last_seen).getTime() <= ONLINE_GRACE_MS

  const selectedVehicle =
    visibleVehicles.find((vehicle) => vehicle.vehicle_id === selectedVehicleId) ?? null
  const onlineCount = visibleVehicles.filter(isOnline).length
  const activeTrips = visibleVehicles.filter((vehicle) => vehicle.trip_id !== null).length
  const vehicleAlerts = alerts.filter(
    (alert) =>
      selectedVehicle !== null &&
      selectedVehicle.trip_id !== null &&
      alert.vehicle_id === selectedVehicle.vehicle_id &&
      alert.trip_id === selectedVehicle.trip_id,
  )

  const liveTrail = useMemo(() => {
    if (!selectedVehicle) return null
    const trail = trails[selectedVehicle.vehicle_id]
    if (!trail) return null
    if (selectedVehicle.trip_id !== null && trail.tripId !== selectedVehicle.trip_id) return null
    return trail
  }, [selectedVehicle, trails])
  const tripSummary = useMemo(
    () => (liveTrail ? summarizeTrail(liveTrail.points) : null),
    [liveTrail],
  )

  useEffect(() => {
    if (!selectedVehicle) {
      setRoute([])
      setPlannedCount(0)
      setForceDeviate(false)
      return
    }
    const vehicleId = selectedVehicle.vehicle_id
    const tripId = selectedVehicle.trip_id
    if (tripId === null) {
      setForceDeviate(false)
      getPlannedRoute(vehicleId, token)
        .then((result) => {
          setPlannedCount(result.point_count)
          setRoute(result.points)
        })
        .catch(() => {
          setPlannedCount(0)
          setRoute([])
        })
      return
    }
    listTrips(vehicleId, token)
      .then((trips) => {
        const active = trips.find((trip) => trip.id === tripId)
        setForceDeviate(Boolean(active?.force_deviate))
      })
      .catch(() => undefined)
    getRoute(vehicleId, tripId, token)
      .then((result) => {
        setRoute(result.points)
        setPlannedCount(result.point_count)
      })
      .catch(() => setRoute([]))
    getReadings(vehicleId, tripId, token)
      .then((readings) =>
        seedTrail(
          vehicleId,
          tripId,
          readings.map((reading) => ({
            lat: reading.latitude,
            lng: reading.longitude,
            t: Date.parse(reading.timestamp),
          })),
        ),
      )
      .catch(() => undefined)
    getAlerts(vehicleId, tripId, token)
      .then((items) =>
        setAlerts((current) => {
          const others = current.filter((alert) => alert.trip_id !== tripId)
          return [...items, ...others]
        }),
      )
      .catch(() => undefined)
  }, [seedTrail, selectedVehicle?.trip_id, selectedVehicle?.vehicle_id, setAlerts, token])

  async function handleCreateVehicle(event: FormEvent) {
    event.preventDefault()
    const name = newVehicleName.trim()
    if (!name) return
    setCreateBusy(true)
    setActionError('')
    try {
      const created = await createVehicle(name, token)
      const live = vehicleFromRecord(created)
      addVehicle(live)
      setSelectedVehicleId(created.id)
      setNewVehicleName('')
      setPlannedCount(0)
      setRoute([])
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not create vehicle')
    } finally {
      setCreateBusy(false)
    }
  }

  async function handleDeleteVehicle(vehicle: LiveVehicle) {
    const confirmed = window.confirm(
      `Delete ${vehicle.name}? This removes its trips, readings, and planned route.`,
    )
    if (!confirmed) return
    setDeleteBusy(true)
    setActionError('')
    try {
      await deleteVehicle(vehicle.vehicle_id, token)
      removeVehicle(vehicle.vehicle_id)
      if (selectedVehicleId === vehicle.vehicle_id) {
        setSelectedVehicleId(null)
        setRoute([])
        setPlannedCount(0)
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not delete vehicle')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function persistPlannedRoute(file: File) {
    if (!selectedVehicle) return
    setRouteBusy(true)
    setActionError('')
    try {
      const result = await savePlannedRoute(selectedVehicle.vehicle_id, file, token)
      setPlannedCount(result.point_count)
      setRoute(result.points)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not save planned route')
    } finally {
      setRouteBusy(false)
    }
  }

  async function saveNamedRoute() {
    const named = NAMED_ROUTES.find((item) => item.id === namedRouteId) ?? NAMED_ROUTES[0]
    await persistPlannedRoute(routeToCsv(named))
  }

  async function toggleTrip(vehicle: LiveVehicle) {
    setTripBusy(vehicle.vehicle_id)
    setActionError('')
    try {
      if (vehicle.trip_id === null) {
        if (plannedCount < 2) {
          setActionError('Save a planned route before starting a trip')
          return
        }
        const trip = await startTrip(vehicle.vehicle_id, token)
        updateTrip(vehicle.vehicle_id, trip.id)
        setForceDeviate(false)
      } else {
        await stopTrip(vehicle.vehicle_id, token)
        updateTrip(vehicle.vehicle_id, null)
        setForceDeviate(false)
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Trip action failed')
    } finally {
      setTripBusy(null)
    }
  }

  async function toggleDeviate() {
    if (!selectedVehicle?.trip_id) return
    setDeviateBusy(true)
    setActionError('')
    try {
      const trip = await setTripDeviate(
        selectedVehicle.vehicle_id,
        selectedVehicle.trip_id,
        token,
        !forceDeviate,
      )
      setForceDeviate(trip.force_deviate)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not change deviation')
    } finally {
      setDeviateBusy(false)
    }
  }

  async function handleRouteUpload(file: File | undefined) {
    if (!file) return
    await persistPlannedRoute(file)
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>Swasemi Fleet</span>
        </div>
        <div className="topbar-actions">
          <div className={`connection-pill ${connection}`}>
            <span />
            {connection === 'connected' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </div>
          <div className="user-block">
            <strong>{user.email}</strong>
            <small>{user.role === 'super_admin' ? 'Super Admin · Platform' : 'Fleet User'}</small>
          </div>
          {user.role === 'super_admin' && (
            <button type="button" className="text-button" onClick={() => { setAdminOpen(true); setHistoryOpen(false) }}>
              Admin
            </button>
          )}
          <button type="button" className="text-button" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <section className="dashboard-body">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow dark">Live operations</p>
              <h2>Fleet overview</h2>
            </div>
            {user.role === 'super_admin' && organizations.length > 0 && (
              <select
                aria-label="Filter organization"
                value={selectedOrg}
                onChange={(event) =>
                  setSelectedOrg(event.target.value === 'all' ? 'all' : Number(event.target.value))
                }
              >
                <option value="all">All organizations</option>
                {organizations.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            )}
          </div>

          <div className="stats">
            <div><strong>{visibleVehicles.length}</strong><span>Vehicles</span></div>
            <div><strong>{onlineCount}</strong><span>Online</span></div>
            <div><strong>{activeTrips}</strong><span>Active trips</span></div>
          </div>

          {actionError && <div className="form-error compact">{actionError}</div>}

          {user.role === 'user' && (
            <form className="create-vehicle" onSubmit={handleCreateVehicle}>
              <input
                type="text"
                value={newVehicleName}
                onChange={(event) => setNewVehicleName(event.target.value)}
                placeholder="New vehicle name"
                aria-label="New vehicle name"
                maxLength={80}
                required
              />
              <button type="submit" disabled={createBusy || !newVehicleName.trim()}>
                {createBusy ? 'Adding…' : 'Add'}
              </button>
            </form>
          )}

          <div className="vehicle-list">
            {visibleVehicles.length === 0 && (
              <div className="empty-state">
                <strong>No vehicles yet</strong>
                <span>{user.role === 'user' ? 'Name a vehicle above, then save a route and start a trip.' : 'No vehicles in this view.'}</span>
              </div>
            )}
            {visibleVehicles.map((vehicle) => {
              const online = isOnline(vehicle)
              return (
                <button
                  key={vehicle.vehicle_id}
                  className={`vehicle-row ${selectedVehicleId === vehicle.vehicle_id ? 'selected' : ''}`}
                  onClick={() => setSelectedVehicleId(vehicle.vehicle_id)}
                >
                  <span className={`status-dot ${online ? 'online' : 'offline'}`} />
                  <span className="vehicle-identity">
                    <strong>{vehicle.name}</strong>
                    <small>{vehicle.org_name ?? vehicle.device_id}</small>
                  </span>
                  <span className="vehicle-meta">
                    <strong>{formatSensor(vehicle.temperature, '°')}</strong>
                    <small>{formatLastSeen(vehicle.last_seen, now)}</small>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="map-stage">
          <FleetMap
            vehicles={visibleVehicles}
            selectedVehicleId={selectedVehicleId}
            route={historyOpen ? historyRoute : route}
            historyTrail={trail}
            liveTrail={historyOpen ? null : liveTrail}
            followToken={`${selectedVehicle?.vehicle_id ?? 'none'}-${selectedVehicle?.trip_id ?? 'stopped'}`}
            onSelect={setSelectedVehicleId}
            isOnline={isOnline}
          />

          {selectedVehicle && !historyOpen && !adminOpen && (
            <article className="vehicle-card">
              <div className="vehicle-card-head">
                <div className="vehicle-card-title">
                  <p className="eyebrow dark">{selectedVehicle.org_name ?? 'Fleet vehicle'}</p>
                  <h3>{selectedVehicle.name}</h3>
                </div>
                <span className={`state-badge ${isOnline(selectedVehicle) ? 'online' : 'offline'}`}>
                  {isOnline(selectedVehicle) ? 'Online' : 'Offline'}
                </span>
              </div>

              <div className="sensor-grid">
                <div><span>Temperature</span><strong>{formatSensor(selectedVehicle.temperature, ' °C')}</strong></div>
                <div><span>Humidity</span><strong>{formatSensor(selectedVehicle.humidity, '%')}</strong></div>
                <div><span>Dew point</span><strong>{formatSensor(selectedVehicle.dew_point, ' °C')}</strong></div>
                <div><span>Elevation</span><strong>{formatSensor(selectedVehicle.elevation, ' m')}</strong></div>
              </div>

              <section className="card-step">
                <div className="card-step-head">
                  <span>Trip</span>
                  <strong>
                    {selectedVehicle.trip_id === null
                      ? 'Not started'
                      : tripSummary && liveTrail && !liveTrail.ended && tripSummary.speedKmh < 4
                        ? `Active · stopped · #${selectedVehicle.trip_id}`
                        : `Active · moving · #${selectedVehicle.trip_id}`}
                  </strong>
                </div>

                {user.role === 'user' && selectedVehicle.trip_id === null && (
                  <>
                    <label className="named-route">
                      Planned route
                      <select
                        value={namedRouteId}
                        onChange={(event) => setNamedRouteId(event.target.value)}
                        aria-label="Named planned route"
                      >
                        {NAMED_ROUTES.map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="card-step-actions">
                      <button
                        type="button"
                        className="upload-button"
                        onClick={saveNamedRoute}
                        disabled={routeBusy}
                      >
                        {routeBusy ? 'Saving…' : 'Save route'}
                      </button>
                      <label className="upload-button">
                        {routeBusy ? 'Saving…' : 'Upload KML'}
                        <input
                          type="file"
                          accept=".kml,.csv,text/xml,text/csv"
                          hidden
                          disabled={routeBusy}
                          onChange={(event) => {
                            handleRouteUpload(event.target.files?.[0])
                            event.target.value = ''
                          }}
                        />
                      </label>
                    </div>
                    <p className="card-hint">
                      {plannedCount > 1
                        ? `Saved · ${plannedCount} points. Start a trip when you are ready.`
                        : 'Save a route first. A trip will not start until you do.'}
                    </p>
                    <button
                      type="button"
                      className="trip-button start"
                      onClick={() => toggleTrip(selectedVehicle)}
                      disabled={tripBusy === selectedVehicle.vehicle_id || plannedCount < 2}
                    >
                      {tripBusy === selectedVehicle.vehicle_id ? 'Working…' : 'Start trip'}
                    </button>
                  </>
                )}

                {user.role === 'user' && selectedVehicle.trip_id !== null && (
                  <>
                    <p className="card-hint">
                      {route.length > 1
                        ? `Following the saved route · ${route.length} points`
                        : 'No planned route on this trip'}
                    </p>
                    <button
                      type="button"
                      className="trip-button stop"
                      onClick={() => toggleTrip(selectedVehicle)}
                      disabled={tripBusy === selectedVehicle.vehicle_id}
                    >
                      {tripBusy === selectedVehicle.vehicle_id ? 'Working…' : 'Stop trip'}
                    </button>
                    <div className="deviate-step">
                      <div>
                        <span>Deviation</span>
                        <strong>{forceDeviate ? 'Driving off the planned route' : 'On the planned corridor'}</strong>
                      </div>
                      <button
                        type="button"
                        className={`trip-button ${forceDeviate ? 'deviating' : 'deviate'}`}
                        onClick={toggleDeviate}
                        disabled={deviateBusy}
                      >
                        {deviateBusy ? 'Working…' : forceDeviate ? 'Deviating' : 'Deviate'}
                      </button>
                    </div>
                  </>
                )}
              </section>

              {tripSummary && liveTrail && liveTrail.points.length > 1 && (
                <div className={`trip-progress ${liveTrail.ended ? 'ended' : ''}`}>
                  <div>
                    <span>{liveTrail.ended ? 'Trip ended' : 'Distance'}</span>
                    <strong>{formatDistance(tripSummary.distanceM)}</strong>
                  </div>
                  <div>
                    <span>Duration</span>
                    <strong>{formatDuration(tripSummary.durationMs)}</strong>
                  </div>
                  <div>
                    <span>Speed</span>
                    <strong>{liveTrail.ended ? '—' : `${Math.round(tripSummary.speedKmh)} km/h`}</strong>
                  </div>
                  <div>
                    <span>Samples</span>
                    <strong>{liveTrail.points.length}</strong>
                  </div>
                </div>
              )}

              {vehicleAlerts[0] && (
                <div className="alert-banner">
                  <strong>Route deviation</strong>
                  <span>{vehicleAlerts[0].message}</span>
                  {vehicleAlerts[0].emailed_at && <small>Email sent</small>}
                </div>
              )}

              <div className="card-footer">
                <button
                  type="button"
                  className="text-button history-link"
                  onClick={() => {
                    setHistoryOpen(true)
                  }}
                >
                  View trip history
                </button>
                {user.role === 'user' && (
                  <button
                    type="button"
                    className="text-button delete-vehicle"
                    onClick={() => handleDeleteVehicle(selectedVehicle)}
                    disabled={deleteBusy}
                  >
                    {deleteBusy ? 'Deleting…' : 'Delete vehicle'}
                  </button>
                )}
              </div>
            </article>
          )}
          {adminOpen && user.role === 'super_admin' && (
            <SuperAdmin token={token} onClose={() => setAdminOpen(false)} />
          )}
          {historyOpen && selectedVehicle && (
            <TripHistory
              key={selectedVehicle.vehicle_id}
              vehicleId={selectedVehicle.vehicle_id}
              vehicleName={selectedVehicle.name}
              token={token}
              onSelectTrip={handleHistoryTrip}
              onClose={() => {
                setHistoryOpen(false)
                setTrail([])
                setHistoryRoute([])
              }}
            />
          )}
        </section>
      </section>
    </main>
  )
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(token !== null)
  const inviteToken = new URLSearchParams(window.location.search).get('invite')

  useEffect(() => {
    if (!token) {
      setCheckingSession(false)
      return
    }
    getCurrentUser(token)
      .then(setUser)
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
      })
      .finally(() => setCheckingSession(false))
  }, [token])

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setUser(null)
  }

  function finishAuth(nextToken: string, nextUser: CurrentUser) {
    localStorage.setItem(TOKEN_KEY, nextToken)
    if (inviteToken) {
      const url = new URL(window.location.href)
      url.searchParams.delete('invite')
      window.history.replaceState({}, '', url)
    }
    setToken(nextToken)
    setUser(nextUser)
  }

  if (checkingSession && !inviteToken) {
    return <main className="loading-screen"><span className="loader" /><p>Loading your fleet…</p></main>
  }

  if (inviteToken && !user) {
    return <JoinScreen token={inviteToken} onJoined={finishAuth} />
  }

  if (!token || !user) {
    return <LoginScreen onAuthenticated={finishAuth} />
  }

  return <Dashboard token={token} user={user} onLogout={logout} />
}
