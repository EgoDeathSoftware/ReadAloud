from fastapi import APIRouter, HTTPException

from readaloud.models.schemas import ExtractRequest, ExtractResponse
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
