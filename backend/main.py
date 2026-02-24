import math
import os
import pathlib
import re
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel

# Load .env from the same directory as this file (local dev only)
load_dotenv(pathlib.Path(__file__).parent / ".env")

EMBED_MODEL = "text-embedding-3-small"


def _get_openai_client() -> AsyncOpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return AsyncOpenAI(api_key=api_key)

app = FastAPI(title="ChatSearch")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PUBLIC_DIR = pathlib.Path(__file__).parent.parent / "public"

# Mount static files at /static — works both locally and on Vercel
# (Vercel bundles the whole repo into the function, so the path exists)
try:
    app.mount("/static", StaticFiles(directory=str(PUBLIC_DIR)), name="static")
except RuntimeError:
    pass  # directory missing in some edge envs


@app.get("/", include_in_schema=False)
async def serve_index():
    index = PUBLIC_DIR / "index.html"
    if not index.exists():
        return {"error": "index.html not found"}
    return FileResponse(str(index))


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    ico = PUBLIC_DIR / "whatsapp-logo.webp"
    if ico.exists():
        return FileResponse(str(ico), media_type="image/webp")
    return FileResponse(str(ico))



class Message(BaseModel):
    time: str
    date: str
    sender: str
    text: str
    is_media: bool = False


class ParsedChat(BaseModel):
    messages: list[Message]
    participants: list[str]
    title: Optional[str] = None


MEDIA_OMITTED = re.compile(r"<[^>]*(?:omitted|attached)[^>]*>", re.IGNORECASE)

# Two common WhatsApp export formats:
#
# Format A (bracketed, US date):  [09:09, 2/24/2026] Sender: text
# Format B (no brackets, EU date): 03/12/2025, 15:29 - Sender: text
#
# Both are tried; whichever matches first wins.

_TIME = r"\d{1,2}:\d{2}(?::\d{2})?(?:\u202f?[APap][Mm])?"
_DATE = r"\d{1,2}/\d{1,2}/\d{2,4}"

# Format A: [time, date] Sender: text
_FMT_A = re.compile(
    rf"^\[({_TIME}),\s*({_DATE})\]\s+([^:]+):\s*(.*)"
)
# Format B: date, time - Sender: text
_FMT_B = re.compile(
    rf"^({_DATE}),\s*({_TIME})\s+-\s+([^:]+):\s*(.*)"
)
# Format B system line (no sender after dash): date, time - system text
_FMT_B_SYS = re.compile(
    rf"^{_DATE},\s*{_TIME}\s+-\s+[^:]+$"
)


def _parse_fmt_a(line: str):
    m = _FMT_A.match(line)
    if not m:
        return None
    time, date, sender, text = m.groups()
    return time.strip(), date.strip(), sender.strip(), text


def _parse_fmt_b(line: str):
    m = _FMT_B.match(line)
    if not m:
        return None
    date, time, sender, text = m.groups()
    parts = date.split("/")
    if len(parts) == 3:
        d, mo, y = parts
        date = f"{mo}/{d}/{y}"
    return time.strip(), date.strip(), sender.strip(), text


def _detect_dominant_format(lines: list[str]) -> str:
    """Return 'A' or 'B' depending on which format appears more in the file."""
    a = sum(1 for l in lines if _FMT_A.match(l))
    b = sum(1 for l in lines if _FMT_B.match(l))
    return "A" if a >= b else "B"


def parse_chat(content: str) -> ParsedChat:
    content = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = content.split("\n")

    dominant = _detect_dominant_format(lines)
    parse_primary   = _parse_fmt_a if dominant == "A" else _parse_fmt_b
    parse_secondary = _parse_fmt_b if dominant == "A" else _parse_fmt_a

    messages: list[Message] = []
    participants: set[str] = set()
    current: Optional[dict] = None

    for line in lines:
        parsed = parse_primary(line)
        if parsed:
            if current:
                messages.append(Message(**current))
            time, date, sender, text = parsed
            participants.add(sender)
            current = {
                "time": time,
                "date": date,
                "sender": sender,
                "text": text.strip(),
                "is_media": bool(MEDIA_OMITTED.search(text)),
            }
        elif current is not None:
            # Could be a genuine multiline continuation OR a pasted foreign-format message.
            # Either way, append as plain text to the current message.
            if line.strip():
                # If it looks like a secondary-format message, label it clearly
                sec = parse_secondary(line)
                if sec:
                    _, _, sec_sender, sec_text = sec
                    current["text"] += f"\n{sec_sender}: {sec_text.strip()}"
                else:
                    current["text"] += "\n" + line

    if current:
        messages.append(Message(**current))

    return ParsedChat(
        messages=messages,
        participants=sorted(participants),
        title=None,
    )


@app.post("/api/parse", response_model=ParsedChat)
async def parse_chat_file(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".txt"):
        raise HTTPException(status_code=400, detail="Only .txt files are supported")

    raw = await file.read()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")

    result = parse_chat(content)
    if not result.messages:
        raise HTTPException(status_code=422, detail="No messages found. Make sure the file is a WhatsApp chat export.")

    return result


# ── Embedding endpoints ───────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    chunks: list[str]


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]


@app.post("/api/embed", response_model=EmbedResponse)
async def embed_chunks(req: EmbedRequest):
    if not req.chunks:
        raise HTTPException(status_code=400, detail="No chunks provided")
    if len(req.chunks) > 2048:
        raise HTTPException(status_code=400, detail="Too many chunks (max 2048)")

    try:
        response = await _get_openai_client().embeddings.create(
            model=EMBED_MODEL,
            input=req.chunks,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OpenAI error: {e}")

    embeddings = [item.embedding for item in response.data]
    return EmbedResponse(embeddings=embeddings)


class ContextSearchRequest(BaseModel):
    query: str
    chunks: list[str]
    embeddings: list[list[float]]
    top_k: int = 5


class ChunkResult(BaseModel):
    chunk_index: int
    chunk_text: str
    score: float


class ContextSearchResponse(BaseModel):
    results: list[ChunkResult]


def _cosine(a: list[float], b: list[float]) -> float:
    dot  = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


@app.post("/api/search/context", response_model=ContextSearchResponse)
async def context_search(req: ContextSearchRequest):
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query is empty")
    if len(req.chunks) != len(req.embeddings):
        raise HTTPException(status_code=400, detail="chunks and embeddings length mismatch")

    try:
        q_response = await _get_openai_client().embeddings.create(
            model=EMBED_MODEL,
            input=[req.query],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OpenAI error: {e}")

    q_vec = q_response.data[0].embedding

    scored = [
        (i, _cosine(q_vec, emb))
        for i, emb in enumerate(req.embeddings)
    ]
    scored.sort(key=lambda x: x[1], reverse=True)

    top_k = min(req.top_k, len(scored))
    results = [
        ChunkResult(
            chunk_index=i,
            chunk_text=req.chunks[i],
            score=round(score, 4),
        )
        for i, score in scored[:top_k]
    ]
    return ContextSearchResponse(results=results)
