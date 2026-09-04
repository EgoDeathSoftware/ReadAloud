from unittest.mock import patch

import pytest

from readaloud.services.url_guard import validate_public_url


def _resolving_to(*addresses):
    """Patch the guard's DNS resolution to return fixed addresses."""
    return patch(
        "readaloud.services.url_guard._resolve_host",
        return_value=list(addresses),
    )


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
        "data:text/html,hello",
    ],
)
def test_rejects_non_http_schemes(url):
    with pytest.raises(ValueError, match="scheme"):
        validate_public_url(url)


def test_rejects_url_without_host():
    with pytest.raises(ValueError, match="host"):
        validate_public_url("http:///nohost")


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.3.4",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
    ],
)
def test_rejects_private_and_link_local_addresses(address):
    with _resolving_to(address):
        with pytest.raises(ValueError, match="private"):
            validate_public_url("http://internal.example.com/")


def test_rejects_when_any_resolved_address_is_private():
    with _resolving_to("93.184.216.34", "127.0.0.1"):
        with pytest.raises(ValueError, match="private"):
            validate_public_url("http://rebind.example.com/")


def test_rejects_unresolvable_host():
    with patch(
        "readaloud.services.url_guard._resolve_host",
        side_effect=OSError("nodename nor servname provided"),
    ):
        with pytest.raises(ValueError, match="resolve"):
            validate_public_url("http://does-not-exist.invalid/")


def test_allows_public_address():
    with _resolving_to("93.184.216.34"):
        validate_public_url("https://example.com/article")


def test_allows_public_ipv6_address():
    with _resolving_to("2606:2800:220:1:248:1893:25c8:1946"):
        validate_public_url("https://example.com/article")


def test_allows_literal_public_ip_without_dns():
    validate_public_url("http://93.184.216.34/page")


def test_rejects_literal_private_ip_without_dns():
    with pytest.raises(ValueError, match="private"):
        validate_public_url("http://169.254.169.254/latest/meta-data/")
