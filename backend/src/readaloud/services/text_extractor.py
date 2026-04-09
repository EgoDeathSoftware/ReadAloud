import xml.etree.ElementTree as ET
from dataclasses import dataclass

import trafilatura

MAX_CHARS = 100_000


@dataclass
class ExtractedContent:
    title: str | None
    text: str
    word_count: int


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
