import type { TrailPoint } from './types'

export type LatLng = [number, number]

const EARTH_RADIUS_M = 6_371_000

export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (value: number) => (value * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (value: number) => (value * Math.PI) / 180
  const lat1 = toRad(a[0])
  const lat2 = toRad(b[0])
  const dLng = toRad(b[1] - a[1])
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export interface TrailSummary {
  distanceM: number
  durationMs: number
  speedKmh: number
}

export function summarizeTrail(points: TrailPoint[]): TrailSummary {
  if (points.length < 2) {
    return { distanceM: 0, durationMs: 0, speedKmh: 0 }
  }
  let distanceM = 0
  for (let index = 1; index < points.length; index += 1) {
    distanceM += haversineM(
      [points[index - 1].lat, points[index - 1].lng],
      [points[index].lat, points[index].lng],
    )
  }

  const recent = points.slice(-5)
  let recentDistance = 0
  for (let index = 1; index < recent.length; index += 1) {
    recentDistance += haversineM(
      [recent[index - 1].lat, recent[index - 1].lng],
      [recent[index].lat, recent[index].lng],
    )
  }
  const recentMs = recent[recent.length - 1].t - recent[0].t
  const speedKmh = recentMs > 0 ? (recentDistance / (recentMs / 1000)) * 3.6 : 0

  return {
    distanceM,
    durationMs: points[points.length - 1].t - points[0].t,
    speedKmh,
  }
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`
}

export function trailMotion(points: TrailPoint[], ended: boolean): 'moving' | 'stopped' | 'ended' | 'idle' {
  if (ended && points.length > 0) return 'ended'
  if (points.length < 2) return 'idle'
  const recent = summarizeTrail(points)
  if (recent.speedKmh < 4) return 'stopped'
  return 'moving'
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
