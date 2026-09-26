import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("ALERT_FROM_EMAIL", SMTP_USERNAME or "alerts@localhost")
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() in {"1", "true", "yes"}
UNDELIVERABLE_DOMAINS = {"example.com", "example.org", "example.net", "localhost", "invalid"}


def smtp_configured() -> bool:
    return bool(SMTP_HOST and SMTP_FROM)


def _deliverable(address: str) -> bool:
    if "@" not in address:
        return False
    domain = address.rsplit("@", 1)[-1].lower()
    return domain not in UNDELIVERABLE_DOMAINS


def send_email(to_addresses: list[str], subject: str, body: str) -> bool:
    recipients = [address for address in to_addresses if address and _deliverable(address)]
    if not recipients:
        logger.warning("No recipients for alert email")
        return False
    if not smtp_configured():
        logger.warning("SMTP is not configured; alert email was not sent")
        return False

    message = EmailMessage()
    message["From"] = SMTP_FROM
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.set_content(body)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
        if SMTP_USE_TLS:
            smtp.starttls()
        if SMTP_USERNAME:
            smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
        smtp.send_message(message)
    logger.info("Alert email sent to %s", recipients)
    return True
