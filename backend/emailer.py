import json
import logging
import os
import smtplib
import ssl
import urllib.error
import urllib.request
from email.message import EmailMessage

logger = logging.getLogger(__name__)

UNDELIVERABLE_DOMAINS = {"example.com", "example.org", "example.net", "localhost", "invalid"}


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def smtp_host() -> str:
    return _env("SMTP_HOST")


def smtp_from() -> str:
    return _env("ALERT_FROM_EMAIL") or _env("SMTP_USERNAME") or "alerts@localhost"


def smtp_configured() -> bool:
    return bool(smtp_host() and smtp_from())


def resend_configured() -> bool:
    return bool(_env("RESEND_API_KEY"))


def _deliverable(address: str) -> bool:
    if "@" not in address:
        return False
    domain = address.rsplit("@", 1)[-1].lower()
    return domain not in UNDELIVERABLE_DOMAINS


def deliverable_recipients(addresses: list[str]) -> list[str]:
    return [address for address in addresses if address and _deliverable(address)]


def fallback_inbox() -> str | None:
    extra = _env("ALERT_TO_EMAIL")
    for address in (extra, smtp_from(), _env("SMTP_USERNAME")):
        if address and _deliverable(address):
            return address
    return None


def resolve_alert_recipients(to_addresses: list[str]) -> list[str]:
    recipients = deliverable_recipients(to_addresses)
    if recipients:
        return list(dict.fromkeys(recipients))
    inbox = fallback_inbox()
    return [inbox] if inbox else []


def send_email(to_addresses: list[str], subject: str, body: str) -> bool:
    ok, _, _ = send_alert_email(to_addresses, subject, body)
    return ok


def send_alert_email(
    to_addresses: list[str],
    subject: str,
    body: str,
) -> tuple[bool, list[str], str]:
    recipients = resolve_alert_recipients(to_addresses)
    if not recipients:
        return False, [], "No deliverable inbox. Set ALERT_TO_EMAIL to your Gmail."
    if resend_configured():
        return _send_resend(recipients, subject, body)
    if smtp_configured():
        return _send_smtp(recipients, subject, body)
    return (
        False,
        recipients,
        "Render blocks Gmail SMTP. Add a free RESEND_API_KEY (https://resend.com) on Render.",
    )


def _send_resend(
    recipients: list[str],
    subject: str,
    body: str,
) -> tuple[bool, list[str], str]:
    api_key = _env("RESEND_API_KEY")
    sender = _env("RESEND_FROM") or "Swasemi Fleet <onboarding@resend.dev>"
    payload = json.dumps(
        {
            "from": sender,
            "to": recipients,
            "subject": subject,
            "text": body,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        logger.warning("Resend rejected the alert email: %s", detail)
        return False, recipients, f"Resend error: {detail}"
    except Exception as error:
        logger.exception("Resend request failed")
        return False, recipients, str(error)
    logger.info("Alert email sent via Resend to %s", recipients)
    return True, recipients, ""


def _send_smtp(
    recipients: list[str],
    subject: str,
    body: str,
) -> tuple[bool, list[str], str]:
    host = smtp_host()
    port = int(_env("SMTP_PORT", "587") or "587")
    username = _env("SMTP_USERNAME")
    password = _env("SMTP_PASSWORD")
    use_tls = _env("SMTP_USE_TLS", "true").lower() in {"1", "true", "yes"}

    message = EmailMessage()
    message["From"] = smtp_from()
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.set_content(body)

    try:
        if port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, timeout=12, context=context) as smtp:
                if username:
                    smtp.login(username, password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=12) as smtp:
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                if username:
                    smtp.login(username, password)
                smtp.send_message(message)
    except OSError as error:
        logger.warning("SMTP send failed: %s", error)
        return (
            False,
            recipients,
            "Render blocks SMTP ports 25/465/587 on free web services. "
            "Add RESEND_API_KEY from https://resend.com and redeploy.",
        )
    except Exception as error:
        logger.exception("SMTP send failed")
        return False, recipients, str(error)
    logger.info("Alert email sent via SMTP to %s", recipients)
    return True, recipients, ""
