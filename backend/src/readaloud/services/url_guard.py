"""SSRF guard for user-supplied URLs.

`/api/extract` fetches arbitrary URLs server-side, so without a filter it reaches
loopback, link-local metadata endpoints (169.254.169.254), and anything else on the
host network. Every URL — including each redirect hop — goes through
`validate_public_url` before a request is made.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = frozenset({"http", "https"})


def _resolve_host(host: str) -> list[str]:
    """Return every address `host` resolves to.

    A hostname with both a public and a private record must be rejected, so all
    records are checked rather than just the first.
    """
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return [info[4][0] for info in infos]


def _normalize(address: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    """Parse an address, unwrapping IPv4-mapped IPv6 forms such as `::ffff:127.0.0.1`.

    `ipaddress` reports the mapped form as neither loopback nor private, so without
    unwrapping it would sail past the checks below.
    """
    ip = ipaddress.ip_address(address.split("%")[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_public_url(url: str) -> None:
    """Raise ValueError unless `url` is http(s) and resolves only to public addresses."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise ValueError(f"Unsupported URL scheme: {scheme or '(none)'}")

    host = parts.hostname
    if not host:
        raise ValueError(f"URL has no host: {url}")

    try:
        ipaddress.ip_address(host)
    except ValueError:
        try:
            addresses = _resolve_host(host)
        except OSError as exc:
            raise ValueError(f"Could not resolve host: {host}") from exc
    else:
        addresses = [host]

    if not addresses:
        raise ValueError(f"Could not resolve host: {host}")

    for address in addresses:
        try:
            ip = _normalize(address)
        except ValueError as exc:
            raise ValueError(f"Could not resolve host: {host}") from exc
        if not _is_public(ip):
            raise ValueError(f"Refusing to fetch private or reserved address: {address}")
