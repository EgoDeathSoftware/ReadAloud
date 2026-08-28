"""Builds real, parseable PDF bytes for extractor tests.

pypdf has no high-level "draw text" API, so these helpers assemble a minimal
content stream directly via pypdf's low-level writer objects.
"""

import io

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def make_pdf_bytes(text: str) -> bytes:
    """A one-page PDF whose content stream renders `text` as Helvetica."""
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)

    font = DictionaryObject()
    font.update(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    font_dict = DictionaryObject()
    font_dict[NameObject("/F1")] = font_ref
    page["/Resources"][NameObject("/Font")] = font_dict

    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 24 Tf 20 100 Td ({text}) Tj ET".encode())
    page.replace_contents(stream)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def make_blank_pdf_bytes() -> bytes:
    """A one-page PDF with no content stream — parses fine, yields no text."""
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()
