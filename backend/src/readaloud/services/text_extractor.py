import xml.etree.ElementTree as ET
from dataclasses import dataclass

import httpx
import trafilatura

from readaloud.services.url_guard import validate_public_url

MAX_CHARS = 100_000
MAX_REDIRECTS = 5
FETCH_TIMEOUT = 15

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


@dataclass
class ExtractedContent:
    title: str | None
    text: str
    word_count: int


async def _fetch_html(url: str) -> str:
    """Fetch a URL, validating the target before each hop.

    Redirects are followed manually rather than by httpx so that a public URL cannot
    bounce the request to a private address. Uses AsyncClient so a slow page does not
    block the event loop and stall in-flight TTS jobs.
    """
    current = url
    async with httpx.AsyncClient(follow_redirects=False, timeout=FETCH_TIMEOUT) as client:
        for _ in range(MAX_REDIRECTS + 1):
            validate_public_url(current)
            try:
                response = await client.get(current, headers=_BROWSER_HEADERS)
            except httpx.HTTPError as exc:
                raise ValueError(f"Could not fetch URL: {url}") from exc

            if response.is_redirect and response.has_redirect_location:
                current = str(response.next_request.url)
                continue

            if response.status_code >= 400:
                raise ValueError(f"Could not fetch URL: {url}")
            return response.text

    raise ValueError(f"Too many redirects for URL: {url}")


async def extract_from_url(url: str) -> ExtractedContent:
    """Extract main text content from a URL using trafilatura.

    Args:
        url: The web page URL to extract content from.

    Returns:
        ExtractedContent with title, text, and word count.

    Raises:
        ValueError: If the URL is not fetchable, points at a private address, or
            yields no extractable content.
    """
    downloaded = await _fetch_html(url)

    text = trafilatura.extract(downloaded)
    if not text:
        raise ValueError(f"No content extracted from: {url}")

    text = text[:MAX_CHARS]
    doc_title = _extract_title(downloaded)

    return ExtractedContent(
        title=doc_title,
        text=text,
        word_count=len(text.split()),
    )


def _extract_title(downloaded: str) -> str | None:
    """Try to extract the document title from XML metadata."""
    metadata = trafilatura.extract(downloaded, output_format="xml", include_comments=False)
    if not metadata:
        return None
    try:
        root = ET.fromstring(metadata)
        title_elem = root.find(".//title")
        if title_elem is not None and title_elem.text:
            return title_elem.text
    except ET.ParseError:
        pass
    return None
