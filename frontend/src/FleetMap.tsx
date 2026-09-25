import { useEffect } from 'react'
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet'

import type { LiveVehicle, Reading, RoutePoint } from './types'

const DEFAULT_CENTER: [number, number] = [12.9716, 77.5946]

function FitVehicles({
  vehicles,
  route,
  trail,
}: {
  vehicles: LiveVehicle[]
  route: RoutePoint[]
  trail: Reading[]
}) {
  const map = useMap()

  useEffect(() => {
    const positions = [
      ...vehicles
        .filter(
          (vehicle): vehicle is LiveVehicle & { latitude: number; longitude: number } =>
            vehicle.latitude !== null && vehicle.longitude !== null,
        )
        .map((vehicle) => [vehicle.latitude, vehicle.longitude] as [number, number]),
      ...route.map((point) => [point.latitude, point.longitude] as [number, number]),
      ...trail.map((point) => [point.latitude, point.longitude] as [number, number]),
    ]

    if (positions.length === 1) {
      map.setView(positions[0], 14)
    } else if (positions.length > 1) {
      map.fitBounds(positions as LatLngBoundsExpression, { padding: [48, 48] })
    }
  }, [map, route, trail, vehicles])

  return null
}

interface FleetMapProps {
  vehicles: LiveVehicle[]
  selectedVehicleId: number | null
  route: RoutePoint[]
  trail: Reading[]
  onSelect: (vehicleId: number) => void
  isOnline: (vehicle: LiveVehicle) => boolean
}

export function FleetMap({
  vehicles,
  selectedVehicleId,
  route,
  trail,
  onSelect,
  isOnline,
}: FleetMapProps) {
  const positioned = vehicles.filter(
    (vehicle): vehicle is LiveVehicle & { latitude: number; longitude: number } =>
      vehicle.latitude !== null && vehicle.longitude !== null,
  )
  const routePath = route.map(
    (point) => [point.latitude, point.longitude] as LatLngExpression,
  )
  const trailPath = trail.map(
    (point) => [point.latitude, point.longitude] as LatLngExpression,
  )

  return (
    <MapContainer center={DEFAULT_CENTER} zoom={13} className="fleet-map" zoomControl>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitVehicles vehicles={positioned} route={route} trail={trail} />
      {routePath.length >= 2 && (
        <Polyline
          positions={routePath}
          pathOptions={{ color: '#176b50', weight: 5, opacity: 0.75 }}
        />
      )}
      {trailPath.length >= 2 && (
        <Polyline
          positions={trailPath}
          pathOptions={{ color: '#2b6cb0', weight: 4, opacity: 0.9, dashArray: '6 8' }}
        />
      )}
      {positioned.map((vehicle) => {
        const online = isOnline(vehicle)
        const selected = selectedVehicleId === vehicle.vehicle_id
        return (
          <CircleMarker
            key={vehicle.vehicle_id}
            center={[vehicle.latitude, vehicle.longitude]}
            radius={selected ? 13 : 10}
            pathOptions={{
              color: selected ? '#ffffff' : online ? '#0b3228' : '#40251f',
              fillColor: online ? '#29d391' : '#f0785c',
              fillOpacity: 1,
              weight: selected ? 4 : 2,
            }}
            eventHandlers={{ click: () => onSelect(vehicle.vehicle_id) }}
          >
            <Popup>
              <strong>{vehicle.name}</strong>
              <span>{vehicle.org_name ?? `Organization ${vehicle.org_id}`}</span>
              <span>{online ? 'Online' : 'Offline'}</span>
              {vehicle.temperature !== null && <span>{vehicle.temperature.toFixed(1)} °C</span>}
            </Popup>
          </CircleMarker>
        )
      })}
    </MapContainer>
  )
}
