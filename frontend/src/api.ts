import type { CurrentUser, FleetAlert, Reading, RouteOut, TokenResponse, Trip } from './types'

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '')
export const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${API_URL.replace(/^http/, 'ws')}/ws`

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = typeof body?.detail === 'string' ? body.detail : 'Request failed'
    throw new Error(detail)
  }

  return response.json() as Promise<T>
}

export function login(email: string, password: string) {
  return request<TokenResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function getCurrentUser(token: string) {
  return request<CurrentUser>('/auth/me', {}, token)
}

export function startTrip(vehicleId: number, token: string) {
  return request<Trip>(`/vehicles/${vehicleId}/trips/start`, { method: 'POST' }, token)
}

export function stopTrip(vehicleId: number, token: string) {
  return request<Trip>(`/vehicles/${vehicleId}/trips/stop`, { method: 'POST' }, token)
}

export async function uploadRoute(vehicleId: number, tripId: number, file: File, token: string) {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(`${API_URL}/vehicles/${vehicleId}/trips/${tripId}/route`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = typeof payload?.detail === 'string' ? payload.detail : 'Could not upload route'
    throw new Error(detail)
  }
  return response.json() as Promise<RouteOut>
}

export function getRoute(vehicleId: number, tripId: number, token: string) {
  return request<RouteOut>(`/vehicles/${vehicleId}/trips/${tripId}/route`, {}, token)
}

export function getAlerts(vehicleId: number, tripId: number, token: string) {
  return request<FleetAlert[]>(`/vehicles/${vehicleId}/trips/${tripId}/alerts`, {}, token)
}

export function listTrips(vehicleId: number, token: string) {
  return request<Trip[]>(`/vehicles/${vehicleId}/trips`, {}, token)
}

export function getReadings(vehicleId: number, tripId: number, token: string) {
  return request<Reading[]>(`/vehicles/${vehicleId}/trips/${tripId}/readings`, {}, token)
}

export async function downloadTripCsv(vehicleId: number, tripId: number, token: string) {
  const response = await fetch(
    `${API_URL}/vehicles/${vehicleId}/trips/${tripId}/export.csv`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!response.ok) {
    throw new Error('Could not export CSV')
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `trip-${tripId}-readings.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
