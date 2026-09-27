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
      [23.2205, 72.651],
      [23.222, 72.651],
      [23.222, 72.6545],
      [23.2243, 72.6545],
      [23.2243, 72.6582],
      [23.2255, 72.6582],
      [23.2255, 72.663],
      [23.2277, 72.663],
      [23.2277, 72.6715],
      [23.225, 72.6715],
      [23.225, 72.674],
      [23.222, 72.674],
      [23.222, 72.676],
      [23.217, 72.676],
      [23.217, 72.673],
      [23.2145, 72.673],
      [23.2145, 72.67],
      [23.2115, 72.67],
      [23.2115, 72.668],
      [23.2075, 72.668],
      [23.2075, 72.666],
      [23.205, 72.666],
      [23.205, 72.661],
      [23.202, 72.661],
      [23.202, 72.652],
      [23.204, 72.652],
      [23.204, 72.645],
      [23.206, 72.645],
      [23.206, 72.638],
      [23.209, 72.638],
      [23.213, 72.636],
      [23.213, 72.64],
      [23.216, 72.64],
      [23.216, 72.644],
      [23.2185, 72.644],
      [23.2185, 72.648],
      [23.2205, 72.648],
    ]),
  },
  {
    id: 'infocity-corridor',
    name: 'Infocity corridor',
    points: points([
      [23.1965, 72.6368],
      [23.1965, 72.64],
      [23.194, 72.64],
      [23.192, 72.642],
      [23.192, 72.645],
      [23.19, 72.645],
      [23.188, 72.65],
      [23.188, 72.654],
      [23.191, 72.654],
      [23.191, 72.658],
      [23.194, 72.658],
      [23.194, 72.655],
      [23.198, 72.655],
      [23.198, 72.651],
      [23.2, 72.651],
      [23.202, 72.646],
    ]),
  },
]

export function routeToCsv(route: NamedRoute): File {
  const body = ['lat,lng', ...route.points.map((point) => `${point.latitude},${point.longitude}`)].join('\n')
  return new File([body], `${route.id}.csv`, { type: 'text/csv' })
}
