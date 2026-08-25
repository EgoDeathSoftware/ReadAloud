from unittest.mock import patch

import httpx
import pytest

from readaloud.services import text_extractor
from readaloud.services.text_extractor import extract_from_url

PUBLIC_IP = "93.184.216.34"
PRIVATE_IP = "127.0.0.1"


@pytest.fixture
def public_dns():
    """Resolve every hostname to a public address so tests never touch real DNS."""
    with patch(
        "readaloud.services.url_guard._resolve_host",
        return_value=[PUBLIC_IP],
    ) as mock:
        yield mock


@pytest.fixture
def requests():
    """Record the URLs the extractor actually requests."""
    return []


def _install_transport(handler, requests):
    """Route the extractor's httpx client through a mock transport."""

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return handler(request)

    transport = httpx.MockTransport(record)
    real_client = httpx.AsyncClient

    def build_client(**kwargs):
        return real_client(transport=transport, **kwargs)

    return patch.object(text_extractor.httpx, "AsyncClient", build_client)


def _html(body: str) -> str:
    return f"<html><head><title>Test Page</title></head><body>{body}</body></html>"


ARTICLE = _html("<article><p>" + "Hello world content here. " * 20 + "</p></article>")


async def test_extracts_text_from_a_public_url(public_dns, requests):
    with _install_transport(lambda _: httpx.Response(200, text=ARTICLE), requests):
        result = await extract_from_url("https://example.com/article")
    assert "Hello world content here" in result.text
    assert result.word_count > 0


async def test_rejects_private_url_without_making_a_request(requests):
    with _install_transport(lambda _: httpx.Response(200, text=ARTICLE), requests):
        with pytest.raises(ValueError, match="private"):
            await extract_from_url("http://169.254.169.254/latest/meta-data/")
    assert requests == []


async def test_rejects_non_http_scheme_without_making_a_request(requests):
    with _install_transport(lambda _: httpx.Response(200, text=ARTICLE), requests):
        with pytest.raises(ValueError, match="scheme"):
            await extract_from_url("file:///etc/passwd")
    assert requests == []


async def test_rejects_redirect_into_a_private_address(requests):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "example.com":
            return httpx.Response(302, headers={"location": "http://127.0.0.1:8000/admin"})
        return httpx.Response(200, text=ARTICLE)

    with patch("readaloud.services.url_guard._resolve_host", return_value=[PUBLIC_IP]):
        with _install_transport(handler, requests):
            with pytest.raises(ValueError, match="private"):
                await extract_from_url("https://example.com/redirect")
    assert requests == ["https://example.com/redirect"]


async def test_follows_a_public_redirect(public_dns, requests):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/redirect":
            return httpx.Response(302, headers={"location": "https://example.com/final"})
        return httpx.Response(200, text=ARTICLE)

    with _install_transport(handler, requests):
        result = await extract_from_url("https://example.com/redirect")
    assert "Hello world content here" in result.text
    assert requests == [
        "https://example.com/redirect",
        "https://example.com/final",
    ]


async def test_rejects_a_redirect_loop(public_dns, requests):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://example.com/next"})

    with _install_transport(handler, requests):
        with pytest.raises(ValueError, match="redirect"):
            await extract_from_url("https://example.com/start")


async def test_http_error_becomes_a_value_error(public_dns, requests):
    with _install_transport(lambda _: httpx.Response(404), requests):
        with pytest.raises(ValueError, match="Could not fetch URL"):
            await extract_from_url("https://example.com/missing")


async def test_empty_page_becomes_a_value_error(public_dns, requests):
    with _install_transport(lambda _: httpx.Response(200, text=_html("")), requests):
        with pytest.raises(ValueError, match="No content extracted"):
            await extract_from_url("https://example.com/empty")


async def test_text_is_truncated_to_the_maximum(public_dns, requests):
    long_page = _html("<article><p>" + "word " * 40_000 + "</p></article>")
    with _install_transport(lambda _: httpx.Response(200, text=long_page), requests):
        result = await extract_from_url("https://example.com/long")
    assert len(result.text) <= text_extractor.MAX_CHARS
