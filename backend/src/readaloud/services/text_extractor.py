import xml.etree.ElementTree as ET
from dataclasses import dataclass

import httpx
import trafilatura

MAX_CHARS = 100_000

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


def _fetch_with_httpx(url: str) -> str | None:
    """Fetch a URL with browser-like headers as fallback when trafilatura fails."""
    try:
        with httpx.Client(follow_redirects=True, timeout=15) as client:
            response = client.get(url, headers=_BROWSER_HEADERS)
            response.raise_for_status()
            return response.text
    except httpx.HTTPError:
        return None


def extract_from_url(url: str) -> ExtractedContent:
    """Extract main text content from a URL using trafilatura.

    Args:
        url: The web page URL to extract content from.

    Returns:
        ExtractedContent with title, text, and word count.

    Raises:
        ValueError: If the URL cannot be fetched or no content is found.
    """
    downloaded = trafilatura.fetch_url(url)
    if downloaded is None:
        downloaded = _fetch_with_httpx(url)
    if downloaded is None:
        raise ValueError(f"Could not fetch URL: {url}")

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
    metadata = trafilatura.extract(
        downloaded, output_format="xml", include_comments=False
    )
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
