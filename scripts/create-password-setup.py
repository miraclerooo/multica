#!/usr/bin/env python3
"""Prepare an expiring first-password link for an existing self-hosted account."""
import argparse
import datetime
import hashlib
import os
from pathlib import Path
import secrets
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--email', required=True)
    parser.add_argument('--url', required=True, help='Public app origin, e.g. https://multica.example.com')
    parser.add_argument('--env-file', type=Path, required=True)
    args = parser.parse_args()
    url = urlparse(args.url)
    if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1')):
        parser.error('Use HTTPS, or HTTP on localhost only')
    if not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        parser.error('--url must be an origin without credentials, path, query, or fragment')
    if '\n' in args.email or '\r' in args.email or '=' in args.email or '@' not in args.email:
        parser.error('Invalid email')
    original = args.env_file.read_text()
    token = secrets.token_urlsafe(32)
    expires = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)
    updates = {
        'MULTICA_PASSWORD_SETUP_EMAIL': args.email.strip().lower(),
        'MULTICA_PASSWORD_SETUP_TOKEN_SHA256': hashlib.sha256(token.encode()).hexdigest(),
        'MULTICA_PASSWORD_SETUP_EXPIRES_AT': expires.strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    lines = [line for line in original.splitlines() if line.split('=', 1)[0] not in updates]
    output = args.env_file.with_name('.password-setup-link.txt')
    # These files contain authentication material; set permissions before writing.
    for path, contents in [(args.env_file, '\n'.join(lines + [f'{k}={v}' for k,v in updates.items()]) + '\n'),
                           (output, args.url.rstrip('/') + '/login?password_setup=1#password-setup=' + token + '\n')]:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(contents)
    print(f'Setup link saved to {output}. Expires in one hour. Recreate the backend before opening it.')


if __name__ == '__main__':
    main()
