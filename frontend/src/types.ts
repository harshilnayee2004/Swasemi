export type Role = 'user' | 'super_admin'

export interface Organization {
  id: number
  name: string
  created_at: string | null
}

export interface Invite {
  id: number
  token: string
  org_id: number
  org_name: string
  email: string | null
  invite_url: string
  expires_at: string
  used_at: string | null
}

export interface InvitePublic {
  org_name: string
  email: string | null
  expires_at: string
}

export interface CurrentUser {
  id: number
  email: string
  role: Role
  org_id: number | null
}

export interface TokenResponse {
  access_token: string
  token_type: string
}

export interface Trip {
  id: number
  vehicle_id: number
  org_id: number
  status: 'active' | 'completed'
  force_deviate: boolean
  started_at: string
  ended_at: string | null
}

export interface RoutePoint {
  seq: number
  latitude: number
  longitude: number
}

export interface RouteOut {
  trip_id: number
  point_count: number
  points: RoutePoint[]
}

export interface PlannedRouteOut {
  vehicle_id: number
  point_count: number
  points: RoutePoint[]
}

export interface VehicleRecord {
  id: number
  org_id: number
  name: string
  device_id: string
  org_name: string | null
  created_at: string | null
}

export interface FleetAlert {
  id: number
  trip_id: number
  vehicle_id: number
  org_id: number
  type: string
  message: string
  latitude: number | null
  longitude: number | null
  created_at: string | null
  emailed_at: string | null
}

export interface Reading {
  id: number
  trip_id: number
  vehicle_id: number
  timestamp: string
  temperature: number | null
  humidity: number | null
  dew_point: number | null
  elevation: number | null
  latitude: number
  longitude: number
}

export interface LiveVehicle {
  vehicle_id: number
  device_id: string
  name: string
  org_id: number
  org_name: string | null
  trip_id: number | null
  last_seen: string | null
  temperature: number | null
  humidity: number | null
  dew_point: number | null
  elevation: number | null
  latitude: number | null
  longitude: number | null
}

export interface TrailPoint {
  lat: number
  lng: number
  t: number
}

export interface VehicleTrail {
  tripId: number
  points: TrailPoint[]
  ended: boolean
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
