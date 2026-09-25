import { useCallback, useEffect, useState } from 'react'

import { WS_URL } from './api'
import type { ConnectionState, FleetAlert, LiveVehicle } from './types'

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

export function useFleetSocket(token: string | null) {
  const [vehicles, setVehicles] = useState<LiveVehicle[]>([])
  const [alerts, setAlerts] = useState<FleetAlert[]>([])
  const [connection, setConnection] = useState<ConnectionState>('connecting')

  useEffect(() => {
    if (!token) {
      setVehicles([])
      setAlerts([])
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
          setVehicles(message.vehicles)
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
  }, [])

  return { vehicles, alerts, connection, updateTrip, setAlerts }
}
