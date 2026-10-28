"""One-message SMTP transport. Input arrives only on stdin, never argv or logs."""

import json
import smtplib
import ssl
import sys
import re
from email.message import EmailMessage


def build_message(payload):
    if payload['host'] != 'school.example' or payload['port'] != 465 or payload['encryption'] != 'ssl':
        raise ValueError('Invalid SMTP endpoint')
    recipient = payload['to']
    if recipient == 'staff@school.example' and payload.get('groupAllowed') is not True:
        raise ValueError('Collegium distribution is blocked')
    live = payload.get('liveAllowed') is True and re.fullmatch(r'[a-zA-Z0-9._%+-]+@school\.example', recipient)
    if (recipient != 'admin@school.example' and not live) or payload['from'] != 'mailer@school.example':
        raise ValueError('Invalid test recipient or sender')
    message = EmailMessage()
    message['From'] = payload['from']
    message['To'] = payload['to']
    message['Subject'] = payload['subject']
    message.set_content(payload['body'])
    if payload.get('html'):
        message.add_alternative(payload['html'], subtype='html')
    return message


def main():
    raw = sys.stdin.buffer.read(3000001)
    if len(raw) > 3000000:
        raise ValueError('Mail too large')
    payload = json.loads(raw)
    message = build_message(payload)
    with smtplib.SMTP_SSL(payload['host'], payload['port'], timeout=12, context=ssl.create_default_context()) as smtp:
        smtp.ehlo()
        smtp.login(payload['username'], payload['password'])
        refused = smtp.send_message(message)
        if refused:
            raise RuntimeError('Recipient refused')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
