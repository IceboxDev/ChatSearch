'use strict';

import { whatsAppLogo } from '/components.js';

const API_BASE = '';  // same origin via FastAPI

// ── Stamp logo slots ─────────────────────────────────────────────────────────
document.getElementById('sidebar-logo').appendChild(whatsAppLogo(40));
document.getElementById('welcome-icon').appendChild(whatsAppLogo(160));
document.getElementById('chat-item-avatar').appendChild(whatsAppLogo(49, 'Chat'));
document.getElementById('chat-header-avatar').appendChild(whatsAppLogo(40, 'Chat'));

// ── DOM refs ──────────────────────────────────────────────────────────────────
const fileInputSidebar  = document.getElementById('file-input');
const fileInputMain     = document.getElementById('file-input-main');
const dropZone          = document.getElementById('drop-zone');
const welcomePanel      = document.getElementById('welcome-panel');
const chatPanel         = document.getElementById('chat-panel');
const loadingOverlay    = document.getElementById('loading-overlay');
const errorToast        = document.getElementById('error-toast');
const chatItem          = document.getElementById('chat-item');
const chatItemName      = document.getElementById('chat-item-name');
const chatItemPreview   = document.getElementById('chat-item-preview');
const chatHeaderName    = document.getElementById('chat-header-name');
const chatHeaderSub     = document.getElementById('chat-header-sub');
const messagesList      = document.getElementById('messages-list');
const messagesContainer = document.getElementById('messages-container');
const myNameInput       = document.getElementById('my-name-input');
const pickerOverlay     = document.getElementById('picker-overlay');
const pickerList        = document.getElementById('picker-list');
const pickerSkip        = document.getElementById('picker-skip');
const searchBtn         = document.getElementById('search-btn');
const searchPanel       = document.getElementById('search-panel');
const searchInput       = document.getElementById('search-input');
const searchCount       = document.getElementById('search-count');
const searchPrev        = document.getElementById('search-prev');
const searchNext        = document.getElementById('search-next');
const searchClose       = document.getElementById('search-close');

// ── Name persistence ──────────────────────────────────────────────────────────
const NAME_KEY = 'chatsearch_my_name';
myNameInput.value = localStorage.getItem(NAME_KEY) || '';
myNameInput.addEventListener('input', () => {
  localStorage.setItem(NAME_KEY, myNameInput.value.trim());
});

// ── State ─────────────────────────────────────────────────────────────────────
let currentChat   = null;
let selfSender    = null;
let pendingData   = null;   // held while picker is open
let pendingFile   = null;

// Context search state
let currentRawBytes  = null;  // ArrayBuffer of the uploaded .txt file
let currentChunks    = null;  // string[] — overlapping message chunks
let currentEmbeddings = null; // float[][] — one vector per chunk (from cache or API)
let searchMode       = 'literal'; // 'literal' | 'context'

// ── Colour assignment for senders ─────────────────────────────────────────────
const senderColourMap = new Map();
let nextColour = 0;
function colourFor(sender) {
  if (!senderColourMap.has(sender)) {
    senderColourMap.set(sender, nextColour % 7);
    nextColour++;
  }
  return senderColourMap.get(sender);
}

// ── File handling ─────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.txt')) {
    showError('Please upload a .txt WhatsApp export file.');
    return;
  }
  uploadFile(file);
}

async function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

[fileInputSidebar, fileInputMain].forEach(input => {
  input.addEventListener('change', e => handleFile(e.target.files[0]));
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

welcomePanel.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
welcomePanel.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

// ── Upload & parse ────────────────────────────────────────────────────────────
async function uploadFile(file) {
  showLoading(true);
  hideError();

  // Read raw bytes for SHA-256 cache key (used by context search)
  let rawBytes = null;
  try {
    rawBytes = await readFileBytes(file);
  } catch {
    // Non-fatal — context search will re-embed if bytes unavailable
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`${API_BASE}/api/parse`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Upload failed.' }));
      throw new Error(err.detail || 'Upload failed.');
    }
    const data = await res.json();
    currentChat      = data;
    currentRawBytes  = rawBytes;
    currentChunks    = null;
    currentEmbeddings = null;
    resolveIdentityAndRender(data, file.name);
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
    fileInputSidebar.value = '';
    fileInputMain.value    = '';
  }
}

// ── Identity resolution ───────────────────────────────────────────────────────
function resolveIdentityAndRender(data, filename) {
  const savedName  = (localStorage.getItem(NAME_KEY) || '').trim();
  const { participants } = data;

  // Exact match against a participant name
  const exactMatch = participants.find(p => p === savedName);
  if (exactMatch) {
    selfSender = exactMatch;
    renderChat(data, filename);
    return;
  }

  // Partial / case-insensitive match
  const looseMatch = savedName
    ? participants.find(p => p.toLowerCase().includes(savedName.toLowerCase()) || savedName.toLowerCase().includes(p.toLowerCase()))
    : null;

  if (looseMatch) {
    selfSender = looseMatch;
    renderChat(data, filename);
    return;
  }

  // No match — show picker
  pendingData = data;
  pendingFile = filename;
  showPicker(participants);
}

// ── Participant picker ────────────────────────────────────────────────────────
function showPicker(participants) {
  pickerList.innerHTML = '';
  participants.forEach(name => {
    const btn = document.createElement('button');
    btn.className    = 'picker-btn';
    btn.textContent  = name;
    btn.addEventListener('click', () => {
      selfSender = name;
      myNameInput.value = name;
      localStorage.setItem(NAME_KEY, name);
      const data = pendingData, file = pendingFile;
      hidePicker();
      renderChat(data, file);
    });
    pickerList.appendChild(btn);
  });
  pickerOverlay.classList.remove('hidden');
}

pickerSkip.addEventListener('click', () => {
  selfSender = null;
  const data = pendingData, file = pendingFile;
  hidePicker();
  renderChat(data, file);
});

function hidePicker() {
  pickerOverlay.classList.add('hidden');
  pendingData = null;
  pendingFile = null;
}

// ── SVG constants (exact WhatsApp paths from live DOM) ───────────────────────
const TAIL_OUT = `<svg viewBox="0 0 8 13" width="8" height="13" preserveAspectRatio="xMidYMid meet"><path opacity="0.13" d="M5.188,1H0v11.193l6.467-8.625C7.526,2.156,6.958,1,5.188,1z"/><path fill="currentColor" d="M5.188,0H0v11.193l6.467-8.625C7.526,1.156,6.958,0,5.188,0z"/></svg>`;
const TAIL_IN  = `<svg viewBox="0 0 8 13" width="8" height="13" preserveAspectRatio="xMidYMid meet"><path opacity="0.13" fill="#000" d="M1.533,3.568L8,12.193V1H2.812C1.042,1,0.474,2.156,1.533,3.568z"/><path fill="currentColor" d="M1.533,2.568L8,11.193V0L2.812,0C1.042,0,0.474,1.156,1.533,2.568z"/></svg>`;
const TICK_SVG = `<svg viewBox="0 0 16 11" width="16" height="11" fill="none"><path d="M11.0714.6528C10.991.5851 10.8894.5513 10.7667.5513c-.1481 0-.2751.0593-.3809.1775L4.1969 8.3652 1.7911 6.0928c-.0424-.0466-.0932-.0825-.1524-.1079-.0593-.0254-.1206-.0381-.184-.0381-.1313 0-.2455.0487-.3429.146l-.311.311c-.0931.0889-.1396.201-.1396.3364 0 .1355.0465.2497.1396.3428L3.797 10.079c.1481.1355.3153.2032.5015.2032.1058 0 .2074-.0232.3047-.0698.0974-.0465.1778-.1121.2412-.1968L11.4903 1.5986c.072-.0973.108-.1968.108-.2983 0-.1566-.0634-.2814-.1904-.3745l-.3365-.2729z" fill="currentColor"/><path d="M8.6212 8.3272c-.1904-.1185-.3724-.237-.5459-.3555-.0804-.0804-.1862-.1206-.3174-.1206-.1481 0-.2687.053-.3618.1558l-.292.3301c-.0846.0973-.127.2052-.127.3237 0 .1313.0466.2455.1397.3428l1.079 1.0728c.1355.1355.3005.2032.4952.2032.1058 0 .2073-.0232.3047-.0698.0973-.0465.1797-.1121.247-.1968L15.8639 1.624c.072-.0846.108-.1841.108-.2983 0-.1439-.0593-.2688-.1778-.3745l-.3554-.2729c-.0804-.0677-.1799-.1016-.2984-.1016-.1438 0-.2687.0593-.3745.1778L8.6212 8.3272z" fill="currentColor"/></svg>`;

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderChat(data, filename) {
  closeSearch();
  const { messages, participants } = data;

  senderColourMap.clear();
  nextColour = 0;

  const chatName = participants.length === 2
    ? participants.filter(p => p !== selfSender).join('') || participants.join(' & ')
    : filename.replace(/\.txt$/i, '');

  chatHeaderName.textContent = chatName;
  chatHeaderSub.textContent  = `${participants.length} participants · ${messages.length} messages`;

  chatItemName.textContent    = chatName;
  const lastMsg               = messages[messages.length - 1];
  chatItemPreview.textContent = lastMsg ? `${lastMsg.sender}: ${lastMsg.text}` : '';
  chatItem.classList.remove('hidden');
  chatItem.classList.add('active');

  messagesList.innerHTML = '';
  let lastDate   = null;
  let lastSender = null;
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < messages.length; i++) {
    const msg  = messages[i];
    const next = messages[i + 1];

    if (msg.date !== lastDate) {
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${formatDate(msg.date)}</span>`;
      fragment.appendChild(sep);
      lastDate   = msg.date;
      lastSender = null;
    }

    const isOut   = selfSender !== null && msg.sender === selfSender;
    // Tail on the last message of a consecutive-sender run
    const isTail  = !next || next.sender !== msg.sender || next.date !== msg.date;
    const isFirst = msg.sender !== lastSender;

    const row = document.createElement('div');
    row.className = `msg-row ${isOut ? 'out' : 'in'}${isTail ? ' has-tail' : ''}`;

    // Tail SVG beside the bubble corner
    if (isTail) {
      const tail = document.createElement('span');
      tail.className = 'msg-tail';
      tail.innerHTML = isOut ? TAIL_OUT : TAIL_IN;
      row.appendChild(tail);
    }

    const bubble = document.createElement('div');
    bubble.className     = 'msg-bubble';
    bubble.dataset.color = colourFor(msg.sender);

    // Sender name: incoming only, first message in a run
    if (!isOut && isFirst) {
      const senderEl = document.createElement('span');
      senderEl.className   = 'msg-sender';
      senderEl.textContent = msg.sender;
      bubble.appendChild(senderEl);
    }

    // Message text (inline so timestamp floats beside it)
    const textEl = document.createElement('span');
    textEl.className   = `msg-text${msg.is_media ? ' is-media' : ''}`;
    textEl.textContent = msg.is_media ? '📎 Media omitted' : msg.text;
    bubble.appendChild(textEl);

    // Invisible spacer reserves space for the timestamp so text wraps before it
    const spacer = document.createElement('span');
    spacer.className = 'msg-spacer';
    bubble.appendChild(spacer);

    // Footer floated right inside bubble
    const footer = document.createElement('div');
    footer.className = 'msg-footer';

    const timeEl = document.createElement('span');
    timeEl.className   = 'msg-time';
    timeEl.textContent = msg.time;
    footer.appendChild(timeEl);

    if (isOut) {
      const tick = document.createElement('span');
      tick.className = 'msg-tick';
      tick.innerHTML = TICK_SVG;
      footer.appendChild(tick);
    }

    bubble.appendChild(footer);
    row.appendChild(bubble);
    fragment.appendChild(row);

    lastSender = msg.sender;
  }

  messagesList.appendChild(fragment);

  welcomePanel.classList.add('hidden');
  chatPanel.classList.remove('hidden');

  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  try {
    const [m, d, y] = dateStr.split('/').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function showLoading(on) {
  loadingOverlay.classList.toggle('hidden', !on);
}

let errorTimer = null;
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove('hidden');
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(hideError, 4000);
}
function hideError() {
  errorToast.classList.add('hidden');
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchHits   = [];   // all mark.search-hit elements in DOM order
let searchCursor = -1;   // index of the currently-highlighted hit

function openSearch() {
  searchPanel.classList.remove('hidden');
  searchBtn.classList.add('active');
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchPanel.classList.add('hidden');
  searchBtn.classList.remove('active');
  clearSearchHighlights();
  searchInput.value = '';
  searchInput.placeholder = 'Search messages…';
  searchCount.textContent = '';
  searchCount.classList.remove('no-results');
  searchHits   = [];
  searchCursor = -1;
  // Reset to literal mode
  searchMode = 'literal';
  document.querySelectorAll('.search-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === 'literal');
  });
  searchPrev.classList.remove('hidden');
  searchNext.classList.remove('hidden');
  // Clear context UI
  document.getElementById('context-progress').classList.add('hidden');
  const cr = document.getElementById('context-results');
  cr.innerHTML = '';
  cr.classList.add('hidden');
}

searchBtn.addEventListener('click', () => {
  if (searchPanel.classList.contains('hidden')) {
    openSearch();
  } else {
    closeSearch();
  }
});

searchClose.addEventListener('click', closeSearch);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !searchPanel.classList.contains('hidden')) {
    closeSearch();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !chatPanel.classList.contains('hidden')) {
    e.preventDefault();
    openSearch();
  }
});

function clearSearchHighlights() {
  messagesList.querySelectorAll('mark.search-hit').forEach(mark => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
}

function highlightTextNode(node, query) {
  const text  = node.nodeValue;
  const lower = text.toLowerCase();
  const q     = query.toLowerCase();
  const idx   = lower.indexOf(q);
  if (idx === -1) return false;

  const before = document.createTextNode(text.slice(0, idx));
  const mark   = document.createElement('mark');
  mark.className   = 'search-hit';
  mark.textContent = text.slice(idx, idx + query.length);
  const after  = document.createTextNode(text.slice(idx + query.length));

  const parent = node.parentNode;
  parent.insertBefore(before, node);
  parent.insertBefore(mark, node);
  parent.insertBefore(after, node);
  parent.removeChild(node);
  return true;
}

function highlightAllInElement(el, query) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const node of textNodes) {
    // Walk through the node, splitting on each match. After highlightTextNode
    // inserts [before, mark, after], the "after" text node is the next thing
    // to scan. We track it via a placeholder inserted before the original node.
    let current = node;
    while (current && current.nodeValue && current.nodeValue.toLowerCase().includes(query.toLowerCase())) {
      // Insert a sentinel before `current` so we can find the inserted `after` node
      const sentinel = document.createComment('');
      current.parentNode.insertBefore(sentinel, current);
      highlightTextNode(current, query);
      // The `after` text node is right after the sentinel's next sibling (the mark)
      const mark = sentinel.nextSibling;       // the <mark> element
      current    = mark ? mark.nextSibling : null;  // the trailing text node
      sentinel.parentNode.removeChild(sentinel);
    }
  }
}

function runSearch(query) {
  clearSearchHighlights();
  searchHits   = [];
  searchCursor = -1;

  if (!query) {
    searchCount.textContent = '';
    searchCount.classList.remove('no-results');
    updateNavButtons();
    return;
  }

  // Highlight only inside msg-text elements (skip sender names / timestamps)
  const textEls = messagesList.querySelectorAll('.msg-text:not(.is-media)');
  textEls.forEach(el => highlightAllInElement(el, query));

  searchHits = Array.from(messagesList.querySelectorAll('mark.search-hit'));

  if (searchHits.length === 0) {
    searchCount.textContent = 'No results';
    searchCount.classList.add('no-results');
    updateNavButtons();
    return;
  }

  searchCount.classList.remove('no-results');
  jumpTo(0);
}

function jumpTo(idx) {
  if (searchHits.length === 0) return;
  if (searchCursor >= 0 && searchCursor < searchHits.length) {
    searchHits[searchCursor].classList.remove('current');
  }
  searchCursor = (idx + searchHits.length) % searchHits.length;
  const hit = searchHits[searchCursor];
  hit.classList.add('current');
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  searchCount.textContent = `${searchCursor + 1} / ${searchHits.length}`;
  updateNavButtons();
}

function updateNavButtons() {
  const has = searchHits.length > 0;
  searchPrev.disabled = !has;
  searchNext.disabled = !has;
}

let searchDebounce = null;
searchInput.addEventListener('input', () => {
  if (searchMode !== 'literal') return;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(searchInput.value.trim()), 120);
});

searchInput.addEventListener('keydown', e => {
  if (searchMode !== 'literal') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (searchHits.length === 0) return;
    jumpTo(e.shiftKey ? searchCursor - 1 : searchCursor + 1);
  }
});

searchNext.addEventListener('click', () => jumpTo(searchCursor + 1));
searchPrev.addEventListener('click', () => jumpTo(searchCursor - 1));

// ── Search mode switching ─────────────────────────────────────────────────────
const searchModeBtns   = document.querySelectorAll('.search-mode-btn');
const contextProgress  = document.getElementById('context-progress');
const contextProgFill  = document.getElementById('context-progress-fill');
const contextProgLabel = document.getElementById('context-progress-label');
const contextResults   = document.getElementById('context-results');

searchModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    if (mode === searchMode) return;
    searchMode = mode;
    searchModeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

    if (mode === 'literal') {
      // Switch to literal: show normal input row controls, hide context UI
      searchInput.placeholder = 'Search messages…';
      searchPrev.classList.remove('hidden');
      searchNext.classList.remove('hidden');
      contextResults.classList.add('hidden');
      contextProgress.classList.add('hidden');
      clearContextResults();
      // Re-run any existing query as literal
      const q = searchInput.value.trim();
      if (q) runSearch(q);
    } else {
      // Switch to context: hide nav arrows, clear literal highlights
      clearSearchHighlights();
      searchHits   = [];
      searchCursor = -1;
      searchCount.textContent = '';
      searchCount.classList.remove('no-results');
      searchPrev.classList.add('hidden');
      searchNext.classList.add('hidden');
      searchInput.placeholder = 'Ask anything about the chat…';
      searchInput.focus();
      // Trigger indexing if not done yet
      ensureEmbeddings();
    }
  });
});

// ── Chunking ──────────────────────────────────────────────────────────────────
const CHUNK_SIZE    = 20;  // messages per chunk
const CHUNK_OVERLAP = 5;   // messages overlap between chunks

function buildChunks(messages) {
  const chunks = [];
  const step   = CHUNK_SIZE - CHUNK_OVERLAP;
  for (let start = 0; start < messages.length; start += step) {
    const slice = messages.slice(start, start + CHUNK_SIZE);
    const text  = slice
      .filter(m => !m.is_media)
      .map(m => `[${m.date} ${m.time}] ${m.sender}: ${m.text}`)
      .join('\n');
    if (text.trim()) chunks.push(text);
    if (start + CHUNK_SIZE >= messages.length) break;
  }
  return chunks;
}

// ── IndexedDB cache ───────────────────────────────────────────────────────────
const IDB_NAME    = 'chatsearch';
const IDB_STORE   = 'embeddings';
const IDB_VERSION = 1;

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function sha256Hex(buffer) {
  const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Embedding flow ────────────────────────────────────────────────────────────
let embedInProgress = false;

async function ensureEmbeddings() {
  if (currentEmbeddings) return;  // already loaded
  if (!currentChat) return;
  if (embedInProgress) return;
  embedInProgress = true;

  // Build chunks
  currentChunks = buildChunks(currentChat.messages);

  // Compute cache key
  let cacheKey = null;
  if (currentRawBytes) {
    try {
      const hash = await sha256Hex(currentRawBytes);
      cacheKey = `embed_v1_${hash}`;
    } catch {
      cacheKey = null;
    }
  }

  // Check IndexedDB cache
  if (cacheKey) {
    try {
      const cached = await idbGet(cacheKey);
      if (cached && cached.embeddings && cached.embeddings.length === currentChunks.length) {
        currentEmbeddings = cached.embeddings;
        embedInProgress   = false;
        onEmbeddingsReady();
        return;
      }
    } catch {
      // cache miss or error — proceed to fetch
    }
  }

  // Show progress bar
  contextProgress.classList.remove('hidden');
  contextResults.classList.add('hidden');
  setProgress(0, currentChunks.length);

  // Embed in batches of 100 to show progress and avoid huge payloads
  const BATCH = 100;
  const allEmbeddings = [];
  try {
    for (let i = 0; i < currentChunks.length; i += BATCH) {
      const batch = currentChunks.slice(i, i + BATCH);
      const res   = await fetch(`${API_BASE}/api/embed`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chunks: batch }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Embedding failed.' }));
        throw new Error(err.detail || 'Embedding failed.');
      }
      const { embeddings } = await res.json();
      allEmbeddings.push(...embeddings);
      setProgress(Math.min(i + BATCH, currentChunks.length), currentChunks.length);
    }

    currentEmbeddings = allEmbeddings;

    // Persist to IndexedDB
    if (cacheKey) {
      idbPut(cacheKey, { embeddings: allEmbeddings }).catch(() => {});
    }

    onEmbeddingsReady();
  } catch (err) {
    showError(`Indexing failed: ${err.message}`);
    contextProgress.classList.add('hidden');
  } finally {
    embedInProgress = false;
  }
}

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  contextProgFill.style.width  = `${pct}%`;
  contextProgLabel.textContent = done >= total
    ? 'Indexed — ready to search'
    : `Indexing… ${done} / ${total} chunks`;
}

function onEmbeddingsReady() {
  // Hide progress after a short delay so user sees "ready"
  setProgress(currentChunks.length, currentChunks.length);
  setTimeout(() => contextProgress.classList.add('hidden'), 1200);

  // If there's already a query waiting, run it
  const q = searchInput.value.trim();
  if (q) runContextSearch(q);
}

// ── Cosine similarity (client-side) ──────────────────────────────────────────
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Context search query ──────────────────────────────────────────────────────
let contextDebounce = null;

async function runContextSearch(query) {
  if (!currentEmbeddings || !currentChunks) return;

  searchCount.textContent = '';
  searchCount.classList.remove('no-results');
  clearContextResults();

  try {
    // Only send the query string — cosine similarity runs locally
    const res = await fetch(`${API_BASE}/api/embed/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Search failed.' }));
      throw new Error(err.detail || 'Search failed.');
    }
    const { embedding: qVec } = await res.json();

    // Score all chunks locally
    const TOP_K = 8;
    const scored = currentEmbeddings
      .map((emb, i) => ({ i, score: cosine(qVec, emb) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map(({ i, score }) => ({ chunk_index: i, chunk_text: currentChunks[i], score: Math.round(score * 10000) / 10000 }));

    renderContextResults(scored, query);
  } catch (err) {
    showError(err.message);
  }
}

// ── Context result rendering ──────────────────────────────────────────────────
function clearContextResults() {
  contextResults.innerHTML = '';
  contextResults.classList.add('hidden');
}

function renderContextResults(results, query) {
  contextResults.innerHTML = '';
  contextResults.classList.remove('hidden');

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className   = 'ctx-empty';
    empty.textContent = 'No relevant messages found.';
    contextResults.appendChild(empty);
    return;
  }

  // Parse chunk text back into first message sender/time for the card header
  results.forEach(r => {
    const lines        = r.chunk_text.split('\n').filter(Boolean);
    const firstLine    = lines[0] || '';
    // [date time] Sender: text
    const headerMatch  = firstLine.match(/^\[(.+?)\]\s+([^:]+):\s*(.*)/);
    const sender       = headerMatch ? headerMatch[2].trim() : '';
    const dateTime     = headerMatch ? headerMatch[1].trim() : '';
    const snippet      = lines.map(l => {
      const m = l.match(/^\[.+?\]\s+[^:]+:\s*(.*)/);
      return m ? m[1] : l;
    }).join('\n').trim();

    const card = document.createElement('div');
    card.className = 'ctx-result';

    const meta = document.createElement('div');
    meta.className = 'ctx-result-meta';

    if (sender) {
      const senderEl = document.createElement('span');
      senderEl.className   = 'ctx-result-sender';
      senderEl.textContent = sender;
      meta.appendChild(senderEl);
    }
    if (dateTime) {
      const timeEl = document.createElement('span');
      timeEl.className   = 'ctx-result-time';
      timeEl.textContent = dateTime;
      meta.appendChild(timeEl);
    }

    const snippetEl = document.createElement('div');
    snippetEl.className   = 'ctx-result-snippet';
    snippetEl.textContent = snippet;

    card.appendChild(meta);
    card.appendChild(snippetEl);

    // Click → scroll to the first message in the chunk in the main view
    card.addEventListener('click', () => scrollToChunk(r.chunk_index));

    contextResults.appendChild(card);
  });
}

function scrollToChunk(chunkIndex) {
  if (!currentChunks || !currentChat) return;
  // Find the approximate message index for this chunk
  const step     = CHUNK_SIZE - CHUNK_OVERLAP;
  const msgStart = chunkIndex * step;

  // Find the msg-row elements (skipping date-separator divs)
  const rows = messagesList.querySelectorAll('.msg-row');
  const target = rows[Math.min(msgStart, rows.length - 1)];
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Brief highlight flash
    target.classList.add('ctx-jump-flash');
    setTimeout(() => target.classList.remove('ctx-jump-flash'), 1200);
  }
}

// Hook context search into the input (separate from literal search debounce)
searchInput.addEventListener('input', () => {
  if (searchMode !== 'context') return;
  clearTimeout(contextDebounce);
  const q = searchInput.value.trim();
  if (!q) { clearContextResults(); return; }
  contextDebounce = setTimeout(() => {
    if (currentEmbeddings) {
      runContextSearch(q);
    }
    // If embeddings aren't ready yet, ensureEmbeddings will call runContextSearch when done
  }, 400);
});

searchInput.addEventListener('keydown', e => {
  if (searchMode !== 'context') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    clearTimeout(contextDebounce);
    if (currentEmbeddings) {
      runContextSearch(q);
    } else {
      ensureEmbeddings();
    }
  }
});

