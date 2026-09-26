import type {
  CurrentUser,
  FleetAlert,
  Invite,
  InvitePublic,
  Organization,
  PlannedRouteOut,
  Reading,
  RouteOut,
  TokenResponse,
  Trip,
  VehicleRecord,
} from './types'

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

export function getInvite(token: string) {
  return request<InvitePublic>(`/auth/invites/${token}`)
}

export function joinWithInvite(token: string, password: string, email?: string) {
  return request<TokenResponse>('/auth/join', {
    method: 'POST',
    body: JSON.stringify({ token, password, email: email || undefined }),
  })
}

export function listOrganizations(token: string) {
  return request<Organization[]>('/admin/organizations', {}, token)
}

export function createOrganization(name: string, token: string) {
  return request<Organization>('/admin/organizations', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, token)
}

export function listOrganizationUsers(orgId: number, token: string) {
  return request<CurrentUser[]>(`/admin/organizations/${orgId}/users`, {}, token)
}

export function createInvite(orgId: number, token: string, email?: string) {
  return request<Invite>('/admin/invites', {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId, email: email || undefined }),
  }, token)
}

export function listInvites(token: string) {
  return request<Invite[]>('/admin/invites', {}, token)
}

export function listVehicles(token: string) {
  return request<VehicleRecord[]>('/vehicles', {}, token)
}

export function createVehicle(name: string, token: string) {
  return request<VehicleRecord>('/vehicles', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, token)
}

export async function deleteVehicle(vehicleId: number, token: string) {
  const response = await fetch(`${API_URL}/vehicles/${vehicleId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = typeof payload?.detail === 'string' ? payload.detail : 'Could not delete vehicle'
    throw new Error(detail)
  }
}

async function postRouteFile(path: string, file: File, token: string, errorLabel: string) {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const detail = typeof payload?.detail === 'string' ? payload.detail : errorLabel
    throw new Error(detail)
  }
  return response.json()
}

export function savePlannedRoute(vehicleId: number, file: File, token: string) {
  return postRouteFile(
    `/vehicles/${vehicleId}/planned-route`,
    file,
    token,
    'Could not save planned route',
  ) as Promise<PlannedRouteOut>
}

export function getPlannedRoute(vehicleId: number, token: string) {
  return request<PlannedRouteOut>(`/vehicles/${vehicleId}/planned-route`, {}, token)
}

export function startTrip(vehicleId: number, token: string) {
  return request<Trip>(`/vehicles/${vehicleId}/trips/start`, { method: 'POST' }, token)
}

export function stopTrip(vehicleId: number, token: string) {
  return request<Trip>(`/vehicles/${vehicleId}/trips/stop`, { method: 'POST' }, token)
}

export function setTripDeviate(vehicleId: number, tripId: number, token: string, enabled: boolean) {
  const path = enabled
    ? `/vehicles/${vehicleId}/trips/${tripId}/deviate`
    : `/vehicles/${vehicleId}/trips/${tripId}/deviate/reset`
  return request<Trip>(path, { method: 'POST' }, token)
}

export function uploadRoute(vehicleId: number, tripId: number, file: File, token: string) {
  return postRouteFile(
    `/vehicles/${vehicleId}/trips/${tripId}/route`,
    file,
    token,
    'Could not upload route',
  ) as Promise<RouteOut>
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
