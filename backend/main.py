import json
import os
import pathlib
import re
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
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

_PUBLIC = pathlib.Path(__file__).parent.parent / "public"

# Read index.html once at startup (available locally; on Vercel the CDN serves
# static assets but the function still handles / so we need the HTML here too)
_INDEX_FILE = _PUBLIC / "index.html"


@app.get("/", include_in_schema=False)
async def _index():
    if _INDEX_FILE.exists():
        return FileResponse(str(_INDEX_FILE))
    return HTMLResponse(_FALLBACK_HTML)


@app.get("/favicon.ico", include_in_schema=False)
async def _favicon():
    ico = _PUBLIC / "whatsapp-logo.webp"
    return FileResponse(str(ico), media_type="image/webp") if ico.exists() else HTMLResponse("", status_code=404)


# Local dev: mount public/ so JS/CSS/assets are served by uvicorn too
if _PUBLIC.exists():
    app.mount("/", StaticFiles(directory=str(_PUBLIC), html=True), name="static")


_FALLBACK_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ChatSearch</title>
  <link rel="icon" type="image/webp" href="/whatsapp-logo.webp" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div id="sidebar-header">
        <div id="sidebar-logo"></div>
        <div id="sidebar-title">ChatSearch</div>
      </div>
      <div id="chat-list">
        <div id="upload-area" class="chat-list-empty">
          <div class="upload-hint-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#8696A0" stroke-width="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <p class="upload-hint-text">Upload a WhatsApp chat export (.txt) to get started</p>
          <label class="upload-btn" for="file-input">Choose file</label>
          <input type="file" id="file-input" accept=".txt" hidden />
          <div id="drop-zone" class="drop-zone">or drop file here</div>
        </div>
        <div id="chat-item" class="chat-item hidden">
          <div class="chat-item-avatar" id="chat-item-avatar"></div>
          <div class="chat-item-info">
            <div class="chat-item-name" id="chat-item-name">Chat</div>
            <div class="chat-item-preview" id="chat-item-preview">...</div>
          </div>
        </div>
      </div>
    </aside>
    <main id="main">
      <div id="welcome-panel">
        <div id="welcome-content">
          <div id="welcome-icon"></div>
          <h1>ChatSearch</h1>
          <p>Upload a WhatsApp chat export to view your conversation</p>
          <div id="name-field">
            <label for="my-name-input" class="name-label">Your name in the chat</label>
            <input type="text" id="my-name-input" class="name-input" placeholder="e.g. Mantas Kandratavičius" autocomplete="off" spellcheck="false" />
            <p class="name-hint">Used to tell your messages apart from others</p>
          </div>
          <label class="upload-btn-main" for="file-input-main">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Upload chat export (.txt)
          </label>
          <input type="file" id="file-input-main" accept=".txt" hidden />
          <p class="welcome-sub">Your messages stay private — nothing is stored on any server</p>
          <p class="built-by">Crafted by <span>Mantas</span></p>
        </div>
      </div>
      <div id="chat-panel" class="hidden">
        <div id="chat-header">
          <div id="chat-header-avatar"></div>
          <div id="chat-header-info">
            <div id="chat-header-name">Chat</div>
            <div id="chat-header-sub"></div>
          </div>
          <button id="search-btn" title="Search messages" aria-label="Search messages">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7"/>
              <line x1="17" y1="17" x2="22" y2="22"/>
            </svg>
          </button>
        </div>
        <div id="search-panel" class="hidden">
          <div id="search-mode-bar">
            <button class="search-mode-btn active" data-mode="literal">Literal</button>
            <button class="search-mode-btn" data-mode="context">Context aware</button>
            <button class="search-mode-btn" data-mode="ask">Ask</button>
          </div>
          <div id="search-input-row">
            <svg id="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7"/>
              <line x1="17" y1="17" x2="22" y2="22"/>
            </svg>
            <input type="text" id="search-input" placeholder="Search messages…" autocomplete="off" spellcheck="false" />
            <span id="search-count"></span>
            <button id="search-prev" title="Previous result" aria-label="Previous">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button id="search-next" title="Next result" aria-label="Next">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button id="search-close" title="Close search" aria-label="Close">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div id="context-progress" class="hidden">
            <div id="context-progress-bar"><div id="context-progress-fill"></div></div>
            <span id="context-progress-label">Indexing chat…</span>
          </div>
          <div id="context-results" class="hidden"></div>
          <div id="ask-panel" class="hidden">
            <div id="ask-log"></div>
            <div id="ask-composer">
              <textarea id="ask-input" placeholder="Ask anything about the chat…" rows="1" autocomplete="off" spellcheck="true"></textarea>
              <button id="ask-send" title="Send" aria-label="Send">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
            <div id="ask-footer">
              <button id="ask-new-chat">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                New conversation
              </button>
              <span id="ask-rag-status"></span>
            </div>
          </div>
        </div>
        <div id="messages-container">
          <div id="messages-list"></div>
        </div>
      </div>
      <div id="loading-overlay" class="hidden">
        <div class="spinner"></div>
        <p>Parsing chat…</p>
      </div>
      <div id="picker-overlay" class="hidden">
        <div id="picker-modal">
          <p id="picker-title">Who are you in this chat?</p>
          <p id="picker-sub">Your name wasn't found — pick yourself from the list</p>
          <div id="picker-list"></div>
          <button id="picker-skip">Show without sides</button>
        </div>
      </div>
      <div id="error-toast" class="hidden"></div>
    </main>
  </div>
  <script type="module" src="/app.js"></script>
</body>
</html>"""


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
_DATE = r"\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}"

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


def _expand_year(y: str) -> str:
    if len(y) == 2:
        return ("20" if int(y) <= 30 else "19") + y
    return y


def _parse_fmt_b(line: str):
    m = _FMT_B.match(line)
    if not m:
        return None
    date, time, sender, text = m.groups()
    parts = re.split(r"[/.\-]", date)
    if len(parts) == 3:
        d, mo, y = parts
        date = f"{mo}/{d}/{_expand_year(y)}"
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


class QueryEmbedRequest(BaseModel):
    query: str


class QueryEmbedResponse(BaseModel):
    embedding: list[float]


@app.post("/api/embed/query", response_model=QueryEmbedResponse)
async def embed_query(req: QueryEmbedRequest):
    """Embed a single search query. Cosine similarity is computed client-side."""
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query is empty")
    try:
        response = await _get_openai_client().embeddings.create(
            model=EMBED_MODEL,
            input=[req.query],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OpenAI error: {e}")
    return QueryEmbedResponse(embedding=response.data[0].embedding)


# ── Chat / Q-A endpoint ───────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]          # full conversation so far
    rag_chunks: list[str] = []           # top-K retrieved chunk texts for this turn


_SYSTEM_PROMPT = """You are a helpful assistant answering questions about a WhatsApp chat export.
The user has retrieved the most relevant excerpts from the chat for each question.
Use the provided excerpts as your primary source. Be concise, direct, and conversational.
When quoting messages include the sender's name. If the excerpts don't contain enough information, say so honestly."""


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Streaming chat completion with optional RAG context injected per turn."""
    if not req.messages:
        raise HTTPException(status_code=400, detail="No messages provided")

    # Build the OpenAI messages list
    oai_messages: list[dict] = [{"role": "system", "content": _SYSTEM_PROMPT}]

    # For all turns except the last, pass them verbatim
    for msg in req.messages[:-1]:
        oai_messages.append({"role": msg.role, "content": msg.content})

    # Inject RAG context into the final user turn
    last = req.messages[-1]
    if req.rag_chunks:
        context_block = "\n\n---\n".join(req.rag_chunks)
        augmented = (
            f"Relevant excerpts from the chat:\n\n{context_block}\n\n"
            f"---\n\nUser question: {last.content}"
        )
    else:
        augmented = last.content

    oai_messages.append({"role": "user", "content": augmented})

    async def generate():
        try:
            stream = await _get_openai_client().chat.completions.create(
                model="gpt-5-mini",
                messages=oai_messages,
                stream=True,
                max_completion_tokens=1024,
                temperature=0.4,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    # SSE format: data: <json>\n\n
                    yield f"data: {json.dumps({'content': delta})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
