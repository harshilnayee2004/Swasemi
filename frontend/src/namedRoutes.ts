import type { RoutePoint } from './types'

export interface NamedRoute {
  id: string
  name: string
  points: RoutePoint[]
}

function points(coords: Array<[number, number]>): RoutePoint[] {
  return coords.map(([latitude, longitude], seq) => ({ seq, latitude, longitude }))
}

export const NAMED_ROUTES: NamedRoute[] = [
  {
    id: 'gandhinagar-loop',
    name: 'Gandhinagar loop',
    points: points([
      [23.2205, 72.648],
      [23.2243, 72.6582],
      [23.2277, 72.6715],
      [23.217, 72.676],
      [23.2075, 72.666],
      [23.202, 72.652],
      [23.206, 72.638],
      [23.213, 72.636],
      [23.2205, 72.648],
    ]),
  },
  {
    id: 'infocity-corridor',
    name: 'Infocity corridor',
    points: points([
      [23.1965, 72.6368],
      [23.192, 72.642],
      [23.188, 72.65],
      [23.191, 72.658],
      [23.198, 72.655],
      [23.202, 72.646],
    ]),
  },
]

export function routeToCsv(route: NamedRoute): File {
  const body = ['lat,lng', ...route.points.map((point) => `${point.latitude},${point.longitude}`)].join('\n')
  return new File([body], `${route.id}.csv`, { type: 'text/csv' })
}
