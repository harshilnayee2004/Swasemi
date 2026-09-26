import { useCallback, useEffect, useState } from 'react'

import { WS_URL } from './api'
import type { ConnectionState, FleetAlert, LiveVehicle, TrailPoint, VehicleTrail } from './types'

interface SnapshotMessage {
  type: 'snapshot'
  vehicles: LiveVehicle[]
}

interface ReadingMessage extends LiveVehicle {
  type: 'reading'
}

interface AlertMessage extends FleetAlert {
  type: 'alert'
  alert_type?: string
}

const MAX_TRAIL_POINTS = 4000

type TrailMap = Record<number, VehicleTrail>

function appendPoint(
  trails: TrailMap,
  vehicleId: number,
  tripId: number,
  point: TrailPoint,
): TrailMap {
  const existing = trails[vehicleId]
  if (!existing || existing.tripId !== tripId) {
    return { ...trails, [vehicleId]: { tripId, points: [point], ended: false } }
  }
  const last = existing.points[existing.points.length - 1]
  if (last && last.t >= point.t) return trails
  const points = [...existing.points, point].slice(-MAX_TRAIL_POINTS)
  return { ...trails, [vehicleId]: { tripId, points, ended: false } }
}

export function useFleetSocket(token: string | null) {
  const [vehicles, setVehicles] = useState<LiveVehicle[]>([])
  const [alerts, setAlerts] = useState<FleetAlert[]>([])
  const [trails, setTrails] = useState<TrailMap>({})
  const [connection, setConnection] = useState<ConnectionState>('connecting')

  useEffect(() => {
    if (!token) {
      setVehicles([])
      setAlerts([])
      setTrails({})
      setConnection('disconnected')
      return
    }

    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let stopped = false
    let retry = 0

    const connect = () => {
      setConnection('connecting')
      socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`)

      socket.onopen = () => {
        retry = 0
        setConnection('connected')
      }

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as SnapshotMessage | ReadingMessage | AlertMessage
        if (message.type === 'snapshot') {
          setVehicles((current) => {
            const previous = new Map(current.map((vehicle) => [vehicle.vehicle_id, vehicle]))
            return message.vehicles.map((vehicle) => ({
              ...previous.get(vehicle.vehicle_id),
              ...vehicle,
            }))
          })
          return
        }
        if (message.type === 'reading') {
          setVehicles((current) =>
            current.map((vehicle) =>
              vehicle.vehicle_id === message.vehicle_id
                ? { ...vehicle, ...message }
                : vehicle,
            ),
          )
          if (message.trip_id !== null && message.latitude !== null && message.longitude !== null) {
            const point: TrailPoint = {
              lat: message.latitude,
              lng: message.longitude,
              t: message.last_seen ? Date.parse(message.last_seen) : Date.now(),
            }
            setTrails((current) => appendPoint(current, message.vehicle_id, message.trip_id as number, point))
          }
          return
        }
        if (message.type === 'alert') {
          const alert: FleetAlert = {
            id: message.id,
            trip_id: message.trip_id,
            vehicle_id: message.vehicle_id,
            org_id: message.org_id,
            type: message.alert_type ?? message.type,
            message: message.message,
            latitude: message.latitude,
            longitude: message.longitude,
            created_at: message.created_at,
            emailed_at: message.emailed_at,
          }
          setAlerts((current) =>
            current.some((item) => item.id === alert.id) ? current : [alert, ...current],
          )
        }
      }

      socket.onclose = () => {
        setConnection('disconnected')
        if (stopped) return
        const delay = Math.min(1000 * 2 ** retry, 10_000)
        retry += 1
        reconnectTimer = window.setTimeout(connect, delay)
      }

      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      stopped = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [token])

  const updateTrip = useCallback((vehicleId: number, tripId: number | null) => {
    setVehicles((current) =>
      current.map((vehicle) =>
        vehicle.vehicle_id === vehicleId
          ? { ...vehicle, trip_id: tripId }
          : vehicle,
      ),
    )
    setTrails((current) => {
      if (tripId === null) {
        const existing = current[vehicleId]
        return existing ? { ...current, [vehicleId]: { ...existing, ended: true } } : current
      }
      return { ...current, [vehicleId]: { tripId, points: [], ended: false } }
    })
  }, [])

  const seedTrail = useCallback((vehicleId: number, tripId: number, points: TrailPoint[]) => {
    setTrails((current) => {
      const existing = current[vehicleId]
      const lastSeeded = points[points.length - 1]?.t ?? 0
      const live =
        existing && existing.tripId === tripId
          ? existing.points.filter((point) => point.t > lastSeeded)
          : []
      return {
        ...current,
        [vehicleId]: { tripId, points: [...points, ...live].slice(-MAX_TRAIL_POINTS), ended: false },
      }
    })
  }, [])

  const addVehicle = useCallback((vehicle: LiveVehicle) => {
    setVehicles((current) =>
      current.some((item) => item.vehicle_id === vehicle.vehicle_id)
        ? current
        : [...current, vehicle],
    )
  }, [])

  const removeVehicle = useCallback((vehicleId: number) => {
    setVehicles((current) => current.filter((vehicle) => vehicle.vehicle_id !== vehicleId))
    setTrails((current) => {
      if (!(vehicleId in current)) return current
      const next = { ...current }
      delete next[vehicleId]
      return next
    })
    setAlerts((current) => current.filter((alert) => alert.vehicle_id !== vehicleId))
  }, [])

  return { vehicles, alerts, trails, connection, updateTrip, seedTrail, setAlerts, addVehicle, removeVehicle }
}
