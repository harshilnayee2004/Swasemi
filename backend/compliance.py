import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from emailer import resolve_alert_recipients, send_alert_email
from geo import distance_to_route_m
from models import Alert, Organization, RoutePoint, Trip, User, Vehicle
from realtime import alert_payload, publish_telemetry

logger = logging.getLogger(__name__)

DEVIATION_METERS = float(os.getenv("ROUTE_DEVIATION_METERS", "200"))
ALERT_COOLDOWN_MINUTES = int(os.getenv("ROUTE_ALERT_COOLDOWN_MINUTES", "10"))


def evaluate_route_compliance(
    db: Session,
    trip: Trip,
    vehicle: Vehicle,
    latitude: float,
    longitude: float,
) -> Alert | None:
    points = (
        db.query(RoutePoint)
        .filter(RoutePoint.trip_id == trip.id)
        .order_by(RoutePoint.seq)
        .all()
    )
    if len(points) < 2:
        return None

    route = [(point.latitude, point.longitude) for point in points]
    distance = distance_to_route_m(latitude, longitude, route)
    if distance <= DEVIATION_METERS:
        return None

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=ALERT_COOLDOWN_MINUTES)
    recent = (
        db.query(Alert)
        .filter(Alert.trip_id == trip.id, Alert.type == "route_deviation")
        .order_by(Alert.id.desc())
        .first()
    )
    if recent is not None:
        created = recent.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created is not None and created >= cutoff:
            return None

    org = db.query(Organization).filter(Organization.id == vehicle.org_id).first()
    org_name = org.name if org else f"organization {vehicle.org_id}"
    message = (
        f"{vehicle.name} is {int(distance)} m off the planned route "
        f"(limit {int(DEVIATION_METERS)} m)."
    )
    alert = Alert(
        trip_id=trip.id,
        vehicle_id=vehicle.id,
        org_id=vehicle.org_id,
        type="route_deviation",
        message=message,
        latitude=latitude,
        longitude=longitude,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)

    recipients = [
        user.email
        for user in db.query(User).filter(User.org_id == vehicle.org_id).all()
    ]
    body = (
        f"{message}\n\n"
        f"Organization: {org_name}\n"
        f"Vehicle: {vehicle.name} ({vehicle.device_id})\n"
        f"Trip ID: {trip.id}\n"
        f"Position: {latitude:.6f}, {longitude:.6f}\n"
    )
    if recipients and not resolve_alert_recipients(recipients):
        logger.warning(
            "Alert created but no email sent - no deliverable org inbox and no SMTP fallback"
        )
    try:
        emailed, _, _ = send_alert_email(recipients, f"Route deviation: {vehicle.name}", body)
        if emailed:
            alert.emailed_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(alert)
    except Exception:
        logger.exception("Failed to send route-deviation email for trip %s", trip.id)

    publish_telemetry(alert_payload(alert, vehicle, org_name))
    return alert


def notify_manual_deviation(
    db: Session,
    trip: Trip,
    vehicle: Vehicle,
    actor: User | None = None,
) -> tuple[bool, list[str], str]:
    org = db.query(Organization).filter(Organization.id == vehicle.org_id).first()
    org_name = org.name if org else f"organization {vehicle.org_id}"
    message = f"{vehicle.name} was marked off-route by the operator."
    alert = Alert(
        trip_id=trip.id,
        vehicle_id=vehicle.id,
        org_id=vehicle.org_id,
        type="route_deviation",
        message=message,
        latitude=None,
        longitude=None,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)

    recipients = [
        user.email
        for user in db.query(User).filter(User.org_id == vehicle.org_id).all()
    ]
    if actor is not None and actor.email:
        recipients.append(actor.email)
    extra = os.getenv("ALERT_TO_EMAIL", "").strip()
    if extra:
        recipients.append(extra)

    body = (
        f"{message}\n\n"
        f"Organization: {org_name}\n"
        f"Vehicle: {vehicle.name} ({vehicle.device_id})\n"
        f"Trip ID: {trip.id}\n"
        f"This alert was sent because Deviate was clicked on the dashboard.\n"
    )
    emailed = False
    sent_to = resolve_alert_recipients(recipients)
    error = ""
    try:
        emailed, sent_to, error = send_alert_email(
            recipients, f"Route deviation: {vehicle.name}", body
        )
        if emailed:
            alert.emailed_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(alert)
    except Exception as exc:
        error = str(exc)
        logger.exception("Failed to send manual deviation email for trip %s", trip.id)

    publish_telemetry(alert_payload(alert, vehicle, org_name))
    return emailed, sent_to, error
