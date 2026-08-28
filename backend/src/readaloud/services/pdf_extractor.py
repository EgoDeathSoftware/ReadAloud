import io

from pypdf import PdfReader
from pypdf.errors import PyPdfError

from readaloud.services.text_extractor import MAX_CHARS, ExtractedContent

MAX_PDF_BYTES = 25 * 1024 * 1024


def extract_from_pdf_bytes(data: bytes) -> ExtractedContent:
    """Extract text content from raw PDF bytes using pypdf.

    Args:
        data: Raw PDF file bytes.

    Returns:
        ExtractedContent with title, text, and word count.

    Raises:
        ValueError: If the bytes are not a valid PDF, the PDF is encrypted, or no
            text could be extracted (e.g. a scanned/image-only PDF).
    """
    try:
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() for page in reader.pages).strip()
    except PyPdfError as exc:
        raise ValueError(f"Could not parse PDF: {exc}") from exc

    if not text:
        raise ValueError("No text could be extracted from this PDF")

    text = text[:MAX_CHARS]
    title = reader.metadata.title if reader.metadata else None

    return ExtractedContent(
        title=title,
        text=text,
        word_count=len(text.split()),
    )
