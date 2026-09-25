import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { getAlerts, getCurrentUser, getRoute, login, startTrip, stopTrip, uploadRoute } from './api'
import { FleetMap } from './FleetMap'
import { TripHistory } from './TripHistory'
import type { CurrentUser, LiveVehicle, Reading, RoutePoint } from './types'
import { useFleetSocket } from './useFleetSocket'

const TOKEN_KEY = 'fleet_access_token'
const ONLINE_GRACE_MS = 20_000

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

function LoginScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: CurrentUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
            <p className="muted">Sign in with the account provided by your administrator.</p>
          </div>

          <label>
            Email address
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />
          </label>

          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" disabled={submitting}>
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
  const { vehicles, alerts, connection, updateTrip, setAlerts } = useFleetSocket(token)
  const [selectedOrg, setSelectedOrg] = useState<number | 'all'>('all')
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null)
  const [tripBusy, setTripBusy] = useState<number | null>(null)
  const [actionError, setActionError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [route, setRoute] = useState<RoutePoint[]>([])
  const [routeBusy, setRouteBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [trail, setTrail] = useState<Reading[]>([])
  const [historyRoute, setHistoryRoute] = useState<RoutePoint[]>([])

  const handleHistoryTrip = useCallback((nextTrail: Reading[], planned: RoutePoint[]) => {
    setTrail(nextTrail)
    setHistoryRoute(planned)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])

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
    (alert) => selectedVehicle !== null && alert.vehicle_id === selectedVehicle.vehicle_id,
  )

  useEffect(() => {
    if (!selectedVehicle?.trip_id) {
      setRoute([])
      return
    }
    const tripId = selectedVehicle.trip_id
    const vehicleId = selectedVehicle.vehicle_id
    getRoute(vehicleId, tripId, token)
      .then((result) => setRoute(result.points))
      .catch(() => setRoute([]))
    getAlerts(vehicleId, tripId, token)
      .then((items) =>
        setAlerts((current) => {
          const others = current.filter((alert) => alert.trip_id !== tripId)
          return [...items, ...others]
        }),
      )
      .catch(() => undefined)
  }, [selectedVehicle?.trip_id, selectedVehicle?.vehicle_id, setAlerts, token])

  async function toggleTrip(vehicle: LiveVehicle) {
    setTripBusy(vehicle.vehicle_id)
    setActionError('')
    try {
      if (vehicle.trip_id === null) {
        const trip = await startTrip(vehicle.vehicle_id, token)
        updateTrip(vehicle.vehicle_id, trip.id)
      } else {
        await stopTrip(vehicle.vehicle_id, token)
        updateTrip(vehicle.vehicle_id, null)
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Trip action failed')
    } finally {
      setTripBusy(null)
    }
  }

  async function handleRouteUpload(file: File | undefined) {
    if (!file || !selectedVehicle?.trip_id) return
    setRouteBusy(true)
    setActionError('')
    try {
      const result = await uploadRoute(selectedVehicle.vehicle_id, selectedVehicle.trip_id, file, token)
      setRoute(result.points)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not upload route')
    } finally {
      setRouteBusy(false)
    }
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
            <small>{user.role === 'super_admin' ? 'Super Admin' : 'Fleet User'}</small>
          </div>
          <button className="text-button" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <section className={`dashboard-body${historyOpen ? ' with-history' : ''}`}>
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

          <div className="vehicle-list">
            {visibleVehicles.length === 0 && (
              <div className="empty-state">
                <strong>No vehicles yet</strong>
                <span>Create vehicles through the API to begin monitoring.</span>
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
            trail={trail}
            onSelect={setSelectedVehicleId}
            isOnline={isOnline}
          />

          {selectedVehicle && (
            <article className="vehicle-card">
              <div className="vehicle-card-head">
                <div>
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

              <div className="trip-row">
                <div>
                  <span>Trip status</span>
                  <strong>{selectedVehicle.trip_id === null ? 'Stopped' : `Active · #${selectedVehicle.trip_id}`}</strong>
                </div>
                {user.role === 'user' && (
                  <button
                    className={selectedVehicle.trip_id === null ? 'trip-button start' : 'trip-button stop'}
                    onClick={() => toggleTrip(selectedVehicle)}
                    disabled={tripBusy === selectedVehicle.vehicle_id}
                  >
                    {tripBusy === selectedVehicle.vehicle_id
                      ? 'Working…'
                      : selectedVehicle.trip_id === null
                        ? 'Start trip'
                        : 'Stop trip'}
                  </button>
                )}
              </div>

              {selectedVehicle.trip_id !== null && (
                <div className="route-row">
                  <div>
                    <span>Planned route</span>
                    <strong>{route.length > 1 ? `${route.length} points loaded` : 'Not uploaded'}</strong>
                  </div>
                  {user.role === 'user' && (
                    <label className="upload-button">
                      {routeBusy ? 'Uploading…' : 'Upload KML'}
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
                  )}
                </div>
              )}

              {vehicleAlerts[0] && (
                <div className="alert-banner">
                  <strong>Route deviation</strong>
                  <span>{vehicleAlerts[0].message}</span>
                  {vehicleAlerts[0].emailed_at && <small>Email sent</small>}
                </div>
              )}

              <button
                className="text-button history-link"
                onClick={() => {
                  setHistoryOpen(true)
                }}
              >
                View trip history
              </button>
            </article>
          )}
        </section>
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
    </main>
  )
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(token !== null)

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

  if (checkingSession) {
    return <main className="loading-screen"><span className="loader" /><p>Loading your fleet…</p></main>
  }

  if (!token || !user) {
    return (
      <LoginScreen
        onAuthenticated={(nextToken, nextUser) => {
          setToken(nextToken)
          setUser(nextUser)
        }}
      />
    )
  }

  return <Dashboard token={token} user={user} onLogout={logout} />
}
