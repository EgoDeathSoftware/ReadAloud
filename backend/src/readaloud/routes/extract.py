from fastapi import APIRouter, File, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from readaloud.models.schemas import ExtractRequest, ExtractResponse
from readaloud.services.pdf_extractor import MAX_PDF_BYTES, extract_from_pdf_bytes
from readaloud.services.text_extractor import extract_from_url

router = APIRouter()


@router.post("/extract")
async def extract_text(request: ExtractRequest) -> ExtractResponse:
    """Extract text content from a URL."""
    try:
        result = await extract_from_url(request.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExtractResponse(
        title=result.title,
        text=result.text,
        word_count=result.word_count,
    )


@router.post("/extract/pdf")
async def extract_pdf(file: UploadFile = File(...)) -> ExtractResponse:
    """Extract text content from an uploaded PDF."""
    data = await file.read()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF exceeds the 25MB upload limit")
    try:
        result = await run_in_threadpool(extract_from_pdf_bytes, data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ExtractResponse(
        title=result.title,
        text=result.text,
        word_count=result.word_count,
    )
