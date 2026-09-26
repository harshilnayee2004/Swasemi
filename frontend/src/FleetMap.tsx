import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { divIcon } from 'leaflet'
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet'

import { bearingDeg, haversineM, trailMotion } from './geo'
import type { LatLng } from './geo'
import type { LiveVehicle, Reading, RoutePoint, VehicleTrail } from './types'

// Gandhinagar, Gujarat
const DEFAULT_CENTER: LatLng = [23.2156, 72.6369]
const MOVE_MS = 1800

interface Pose {
  position: LatLng
  heading: number
}

interface Animation {
  from: LatLng
  to: LatLng
  start: number
}

/** Glide markers between readings so movement looks continuous rather than jumping every tick. */
function useSmoothPoses(vehicles: LiveVehicle[]): Record<number, Pose> {
  const [poses, setPoses] = useState<Record<number, Pose>>({})
  const shown = useRef<Record<number, Pose>>({})
  const animations = useRef<Record<number, Animation>>({})
  const frame = useRef<number | null>(null)

  const step = useCallback((time: number) => {
    let active = false
    const next: Record<number, Pose> = { ...shown.current }
    for (const [key, animation] of Object.entries(animations.current)) {
      const id = Number(key)
      const k = Math.min(1, (time - animation.start) / MOVE_MS)
      next[id] = {
        heading: next[id]?.heading ?? 0,
        position: [
          animation.from[0] + (animation.to[0] - animation.from[0]) * k,
          animation.from[1] + (animation.to[1] - animation.from[1]) * k,
        ],
      }
      if (k >= 1) delete animations.current[id]
      else active = true
    }
    shown.current = next
    setPoses(next)
    frame.current = active ? requestAnimationFrame(step) : null
  }, [])

  useEffect(() => {
    const now = performance.now()
    let changed = false
    for (const vehicle of vehicles) {
      if (vehicle.latitude === null || vehicle.longitude === null) continue
      const target: LatLng = [vehicle.latitude, vehicle.longitude]
      const current = shown.current[vehicle.vehicle_id]
      if (!current) {
        shown.current[vehicle.vehicle_id] = { position: target, heading: 0 }
        changed = true
        continue
      }
      const pending = animations.current[vehicle.vehicle_id]
      const goal = pending ? pending.to : current.position
      if (goal[0] === target[0] && goal[1] === target[1]) continue
      if (haversineM(current.position, target) > 1) {
        shown.current[vehicle.vehicle_id] = {
          ...current,
          heading: bearingDeg(current.position, target),
        }
      }
      animations.current[vehicle.vehicle_id] = { from: current.position, to: target, start: now }
      changed = true
    }
    if (changed && frame.current === null) {
      frame.current = requestAnimationFrame(step)
    }
  }, [step, vehicles])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  return poses
}

function vehicleIcon(online: boolean, selected: boolean, heading: number, motion: string) {
  const classes = ['vehicle-pin', online ? 'online' : 'offline', selected ? 'selected' : '', motion]
  return divIcon({
    className: 'vehicle-icon',
    html: `<div class="${classes.join(' ').trim()}" style="--heading:${heading.toFixed(0)}deg"><span class="pin-ring"></span><span class="pin-arrow"></span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -18],
  })
}

function VehicleMarker({
  vehicle,
  pose,
  online,
  selected,
  motion,
  onSelect,
}: {
  vehicle: LiveVehicle
  pose: Pose
  online: boolean
  selected: boolean
  motion: string
  onSelect: (vehicleId: number) => void
}) {
  const roundedHeading = Math.round(pose.heading / 5) * 5
  const icon = useMemo(
    () => vehicleIcon(online, selected, roundedHeading, motion),
    [motion, online, roundedHeading, selected],
  )
  return (
    <Marker
      position={pose.position}
      icon={icon}
      zIndexOffset={selected ? 1000 : 0}
      eventHandlers={{ click: () => onSelect(vehicle.vehicle_id) }}
    >
      <Popup>
        <strong>{vehicle.name}</strong>
        <span>{vehicle.org_name ?? `Organization ${vehicle.org_id}`}</span>
        <span>{online ? 'Online' : 'Offline'}</span>
        {vehicle.temperature !== null && <span>{vehicle.temperature.toFixed(1)} °C</span>}
      </Popup>
    </Marker>
  )
}

/** Refit only when the selection or the drawn geometry changes, never on every reading. */
function FitOnChange({ points, fitKey }: { points: LatLng[]; fitKey: string }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 1) {
      map.setView(points[0], 15, { animate: true })
    } else if (points.length > 1) {
      map.fitBounds(points as LatLngBoundsExpression, { padding: [60, 60], maxZoom: 16 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map])
  return null
}

function ZoomControls() {
  const map = useMap()
  return (
    <div className="zoom-stack">
      <button type="button" className="zoom-button" onClick={() => map.zoomIn()} aria-label="Zoom in">+</button>
      <button type="button" className="zoom-button" onClick={() => map.zoomOut()} aria-label="Zoom out">−</button>
    </div>
  )
}

/** Keep the selected moving vehicle in view, like turn-by-turn navigation. */
function FollowVehicle({
  target,
  enabled,
  onUserPan,
}: {
  target: LatLng | null
  enabled: boolean
  onUserPan: () => void
}) {
  const map = useMap()
  useMapEvents({ dragstart: onUserPan })
  useEffect(() => {
    if (!enabled || !target) return
    if (!map.getBounds().pad(-0.3).contains(target)) {
      map.panTo(target, { animate: true, duration: 0.9 })
    }
  }, [enabled, map, target])
  return null
}

interface FleetMapProps {
  vehicles: LiveVehicle[]
  selectedVehicleId: number | null
  route: RoutePoint[]
  historyTrail: Reading[]
  liveTrail: VehicleTrail | null
  followToken: string
  onSelect: (vehicleId: number) => void
  isOnline: (vehicle: LiveVehicle) => boolean
}

export function FleetMap({
  vehicles,
  selectedVehicleId,
  route,
  historyTrail,
  liveTrail,
  followToken,
  onSelect,
  isOnline,
}: FleetMapProps) {
  const [follow, setFollow] = useState(true)
  const poses = useSmoothPoses(vehicles)

  useEffect(() => {
    setFollow(true)
  }, [followToken])

  const positioned = vehicles.filter(
    (vehicle): vehicle is LiveVehicle & { latitude: number; longitude: number } =>
      vehicle.latitude !== null && vehicle.longitude !== null,
  )
  const selected = positioned.find((vehicle) => vehicle.vehicle_id === selectedVehicleId) ?? null

  const routePath = route.map((point) => [point.latitude, point.longitude] as LatLngExpression)
  const historyPath = historyTrail.map((point) => [point.latitude, point.longitude] as LatLngExpression)
  const livePoints = liveTrail?.points ?? []
  const livePath = livePoints.map((point) => [point.lat, point.lng] as LatLngExpression)
  const liveStart = livePoints[0]
  const liveEnd = livePoints[livePoints.length - 1]

  const fitPoints: LatLng[] = selected
    ? [
        [selected.latitude, selected.longitude],
        ...route.map((point) => [point.latitude, point.longitude] as LatLng),
        ...historyTrail.map((point) => [point.latitude, point.longitude] as LatLng),
      ]
    : positioned.map((vehicle) => [vehicle.latitude, vehicle.longitude] as LatLng)
  const fitKey = `${selectedVehicleId ?? 'all'}|${route.length}|${historyTrail.length}|${positioned.length > 0}`

  const followTarget: LatLng | null =
    selected && liveTrail && !liveTrail.ended && selected.trip_id !== null
      ? poses[selected.vehicle_id]?.position ?? [selected.latitude, selected.longitude]
      : null
  const motion = trailMotion(livePoints, liveTrail?.ended ?? false)
  const hudLabel =
    motion === 'moving'
      ? 'En route · Gandhinagar'
      : motion === 'stopped'
        ? 'Stopped · Gandhinagar'
        : motion === 'ended'
          ? 'Trip ended'
          : 'Gandhinagar, Gujarat'

  return (
    <div className="map-shell">
      <MapContainer center={DEFAULT_CENTER} zoom={13} className="fleet-map" zoomControl={false}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
        <FitOnChange points={fitPoints} fitKey={fitKey} />
        <FollowVehicle target={followTarget} enabled={follow} onUserPan={() => setFollow(false)} />
        <ZoomControls />

        {routePath.length >= 2 && (
          <Polyline
            positions={routePath}
            pathOptions={{ color: '#188038', weight: 7, opacity: 0.38, lineCap: 'round', lineJoin: 'round' }}
          />
        )}
        {historyPath.length >= 2 && (
          <Polyline
            positions={historyPath}
            pathOptions={{ color: '#5f6368', weight: 4, opacity: 0.9, dashArray: '6 8' }}
          />
        )}
        {livePath.length >= 2 && (
          <>
            <Polyline
              positions={livePath}
              pathOptions={{ color: '#ffffff', weight: 11, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }}
            />
            <Polyline
              positions={livePath}
              pathOptions={{
                color: liveTrail?.ended ? '#5f6368' : '#1a73e8',
                weight: 6,
                opacity: 1,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </>
        )}
        {liveStart && (
          <CircleMarker
            center={[liveStart.lat, liveStart.lng]}
            radius={8}
            pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#34a853', fillOpacity: 1 }}
          />
        )}
        {liveTrail?.ended && liveEnd && (
          <CircleMarker
            center={[liveEnd.lat, liveEnd.lng]}
            radius={8}
            pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#ea4335', fillOpacity: 1 }}
          />
        )}

        {positioned.map((vehicle) => {
          const pose = poses[vehicle.vehicle_id] ?? {
            position: [vehicle.latitude, vehicle.longitude] as LatLng,
            heading: 0,
          }
          const vehicleMotion =
            selectedVehicleId === vehicle.vehicle_id
              ? motion
              : vehicle.trip_id === null
                ? 'idle'
                : 'moving'
          return (
            <VehicleMarker
              key={vehicle.vehicle_id}
              vehicle={vehicle}
              pose={pose}
              online={isOnline(vehicle)}
              selected={selectedVehicleId === vehicle.vehicle_id}
              motion={vehicleMotion}
              onSelect={onSelect}
            />
          )
        })}
      </MapContainer>

      <div className="map-place-chip">
        <strong>{hudLabel}</strong>
        <small>
          {motion === 'moving'
            ? 'Following the live GPS trail'
            : motion === 'stopped'
              ? 'Holding position — like a signal stop'
              : motion === 'ended'
                ? 'Start and end pins stay on the path'
                : 'Start a trip to draw the route'}
        </small>
      </div>

      <div className="map-controls">
        <button
          className={`map-control ${follow ? 'active' : ''}`}
          onClick={() => setFollow((value) => !value)}
          title="Keep the selected vehicle in view"
        >
          <span className="control-icon">◎</span>
          {follow ? 'Following' : 'Follow'}
        </button>
      </div>
    </div>
  )
}
