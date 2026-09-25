import { useEffect, useMemo, useState } from 'react'

import { downloadTripCsv, getReadings, getRoute, listTrips } from './api'
import type { Reading, RoutePoint, Trip } from './types'

interface TripHistoryProps {
  vehicleId: number
  vehicleName: string
  token: string
  onClose: () => void
  onSelectTrip: (trail: Reading[], planned: RoutePoint[]) => void
}

function formatWhen(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function TemperatureChart({ readings }: { readings: Reading[] }) {
  const series = readings.filter((reading) => reading.temperature !== null)
  const width = 420
  const height = 140
  const pad = 18

  const path = useMemo(() => {
    if (series.length === 0) return ''
    const temps = series.map((reading) => reading.temperature as number)
    const min = Math.min(...temps)
    const max = Math.max(...temps)
    const span = max - min || 1
    return series
      .map((reading, index) => {
        const x = pad + (index / Math.max(series.length - 1, 1)) * (width - pad * 2)
        const y = height - pad - (((reading.temperature as number) - min) / span) * (height - pad * 2)
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }, [series])

  if (series.length === 0) {
    return <p className="muted">No temperature samples on this trip.</p>
  }

  const last = series[series.length - 1].temperature as number
  const first = series[0].temperature as number

  return (
    <div className="chart-block">
      <div className="chart-legend">
        <span>Temperature</span>
        <strong>{first.toFixed(1)}° → {last.toFixed(1)}°</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="temp-chart" role="img" aria-label="Temperature over the trip">
        <path d={path} fill="none" stroke="#176b50" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  )
}

export function TripHistory({
  vehicleId,
  vehicleName,
  token,
  onClose,
  onSelectTrip,
}: TripHistoryProps) {
  const [trips, setTrips] = useState<Trip[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [readings, setReadings] = useState<Reading[]>([])
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    listTrips(vehicleId, token)
      .then((items) => {
        setTrips(items)
        setSelectedId(items[0]?.id ?? null)
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load trips'))
  }, [token, vehicleId])

  useEffect(() => {
    if (selectedId === null) {
      setReadings([])
      onSelectTrip([], [])
      return
    }
    Promise.all([
      getReadings(vehicleId, selectedId, token),
      getRoute(vehicleId, selectedId, token).catch(() => ({ points: [] as RoutePoint[] })),
    ])
      .then(([nextReadings, route]) => {
        setReadings(nextReadings)
        onSelectTrip(nextReadings, route.points)
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load trip'))
  }, [onSelectTrip, selectedId, token, vehicleId])

  async function exportCsv() {
    if (selectedId === null) return
    setExporting(true)
    setError('')
    try {
      await downloadTripCsv(vehicleId, selectedId, token)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CSV export failed')
    } finally {
      setExporting(false)
    }
  }

  const selected = trips.find((trip) => trip.id === selectedId) ?? null

  return (
    <aside className="history-panel">
      <div className="history-head">
        <div>
          <p className="eyebrow dark">Trip history</p>
          <h3>{vehicleName}</h3>
        </div>
        <button className="text-button" onClick={onClose}>Close</button>
      </div>

      {error && <div className="form-error compact">{error}</div>}

      <div className="history-trips">
        {trips.length === 0 && <p className="muted">No trips recorded yet.</p>}
        {trips.map((trip) => (
          <button
            key={trip.id}
            className={`history-trip ${selectedId === trip.id ? 'selected' : ''}`}
            onClick={() => setSelectedId(trip.id)}
          >
            <strong>Trip #{trip.id}</strong>
            <small>{trip.status} · {formatWhen(trip.started_at)}</small>
          </button>
        ))}
      </div>

      {selected && (
        <>
          <TemperatureChart readings={readings} />
          <div className="history-actions">
            <span>{readings.length} readings · GPS trail on map</span>
            <button className="upload-button" onClick={exportCsv} disabled={exporting || readings.length === 0}>
              {exporting ? 'Exporting…' : 'Download CSV'}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
