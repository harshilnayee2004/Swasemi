import math
import re
import xml.etree.ElementTree as ET

EARTH_RADIUS_M = 6_371_000


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def _to_xy(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * EARTH_RADIUS_M
    y = math.radians(lat - lat0) * EARTH_RADIUS_M
    return x, y


def distance_to_route_m(
    latitude: float,
    longitude: float,
    route: list[tuple[float, float]],
) -> float:
    if not route:
        return float("inf")
    if len(route) == 1:
        return haversine_m(latitude, longitude, route[0][0], route[0][1])

    lat0, lon0 = route[0]
    px, py = _to_xy(latitude, longitude, lat0, lon0)
    best = float("inf")
    for (lat_a, lon_a), (lat_b, lon_b) in zip(route, route[1:]):
        ax, ay = _to_xy(lat_a, lon_a, lat0, lon0)
        bx, by = _to_xy(lat_b, lon_b, lat0, lon0)
        dx, dy = bx - ax, by - ay
        length_sq = dx * dx + dy * dy
        if length_sq == 0:
            t = 0.0
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
        closest_x = ax + t * dx
        closest_y = ay + t * dy
        best = min(best, math.hypot(px - closest_x, py - closest_y))
    return best


def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _parse_coordinate_text(text: str) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for token in re.split(r"\s+", text.strip()):
        if not token:
            continue
        parts = token.split(",")
        if len(parts) < 2:
            continue
        longitude = float(parts[0])
        latitude = float(parts[1])
        points.append((latitude, longitude))
    return points


def parse_kml(content: str) -> list[tuple[float, float]]:
    root = ET.fromstring(content)
    points: list[tuple[float, float]] = []
    for node in root.iter():
        if _strip_ns(node.tag).lower() != "coordinates" or not node.text:
            continue
        points.extend(_parse_coordinate_text(node.text))
    return points


def parse_csv_points(content: str) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("lat"):
            continue
        parts = re.split(r"[,\s;]+", line)
        if len(parts) < 2:
            continue
        latitude = float(parts[0])
        longitude = float(parts[1])
        points.append((latitude, longitude))
    return points


def parse_route_file(filename: str, content: str) -> list[tuple[float, float]]:
    lowered = filename.lower()
    if lowered.endswith(".kml") or "<kml" in content.lower() or "<coordinates" in content.lower():
        points = parse_kml(content)
    else:
        points = parse_csv_points(content)
    if len(points) < 2:
        raise ValueError("Route file must contain at least two coordinates")
    return points
