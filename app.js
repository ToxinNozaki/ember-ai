/* ============================================================
   EMBER AI — app.js
   ============================================================ */

// ── Constants ──────────────────────────────────────────────

const STORAGE_KEY  = 'ember_conversations';
const SETTINGS_KEY = 'ember_settings';
const MAX_CONVS    = 100;
const RENDER_TICK  = 50;   // ms between streaming re-renders
const SLOW_TIMEOUT = 8000; // ms before "Still thinking…" appears
const USAGE_KEY    = 'ember_usage';
const DEFAULT_MODEL = 'gemini:gemini-2.5-flash';
// Baked-in shared Worker URL so friends don't have to configure anything.
// Users can still override it in Settings.
const DEFAULT_WORKER_URL = 'https://ember-ai-proxy.voxbot.workers.dev';
const MAX_IMAGE_DIM = 1280; // downscale attached images to this max edge (speed + storage)

// Provider display names + approximate free daily request limits (for the local
// usage estimate — providers don't expose live quota, so this counts requests
// this browser made today). Limits are ballpark and easy to tweak.
const PROVIDER_META = {
  gemini:     { name: 'Google Gemini', limit: 1500 },
  groq:       { name: 'Groq',          limit: 1000 },
  github:     { name: 'GitHub Models',  limit: 150 },
  openrouter: { name: 'OpenRouter',     limit: 200 },
};

const DEFAULT_SYSTEM_PROMPT =
`You are Ember, a knowledgeable, thoughtful, and friendly AI assistant. You communicate clearly and precisely.

Formatting rules you ALWAYS follow:
- Use **bold** for key terms and important points
- Use *italics* for emphasis or titles
- Use bullet points (- ) for lists of 3 or more items
- Use numbered lists for steps or ranked items
- Use ### headers to organize long responses into sections
- Use horizontal dividers (---) to separate major sections in long answers
- Use tables when comparing multiple things across multiple attributes
- Use \`inline code\` for short code snippets, function names, and commands
- Use triple-backtick code blocks with the correct language label for any code longer than one line

Source citation rules:
- When your answer references factual claims, statistics, named studies, or specific technical documentation, add a "Sources" section at the very end of your message
- Format it as:
  Sources
  1. [Source name or description](URL if known, otherwise just describe it)
- Only include a Sources section if you are genuinely referencing factual external information. Skip it for creative writing, casual conversation, and opinions.

Always aim for clarity. Prefer shorter sentences. Never pad responses with filler phrases.`;

// ── State ──────────────────────────────────────────────────

let conversations      = [];
let activeId           = null;
let isStreaming        = false;
let abortCtrl          = null;
let renderTimer        = null;
let slowTimer          = null;
let streamBuf          = '';    // accumulated raw markdown during streaming
let streamBubble       = null;  // the DOM element receiving streamed content
let confirmCb          = null;  // callback for confirm modal
let pendingImages      = [];    // data URLs of images attached to the next message

// ── Settings helpers ────────────────────────────────────────

function getSettings () {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings (s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
function getSetting  (k, d) { return getSettings()[k] ?? d; }
function setSetting  (k, v) { const s = getSettings(); s[k] = v; saveSettings(s); }

// ── Conversation helpers ────────────────────────────────────

function loadConversations () {
  try { conversations = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { conversations = []; }
}

function persistConversations () {
  if (conversations.length > MAX_CONVS) {
    conversations = [...conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVS);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch (e) {
    // Likely storage quota (large images) — keep newest 20 convs and retry once
    conversations = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch {}
  }
}

function makeConversation () {
  return {
    id:        crypto.randomUUID(),
    title:     'New Conversation',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages:  [],
  };
}

function getActive () { return conversations.find(c => c.id === activeId); }

function autoTitle (text) {
  const t = text.replace(/[*#_`~>\[\]]/g, '').trim();
  return t.length > 52 ? t.slice(0, 49) + '…' : t || 'New Conversation';
}

// Message content can be a plain string or an array of parts (text + images).
function messageText (content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join(' ');
  return '';
}

function messageImages (content) {
  if (Array.isArray(content)) return content.filter(p => p.type === 'image_url').map(p => p.image_url.url);
  return [];
}

// ── Time helpers ────────────────────────────────────────────

function relTime (ts) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  const h = Math.floor(d / 3600000);
  const dy = Math.floor(d / 86400000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  if (h < 24)  return `${h}h ago`;
  if (dy === 1) return 'Yesterday';
  if (dy < 7)  return `${dy} days ago`;
  return new Date(ts).toLocaleDateString();
}

function groupByDate (list) {
  const now = Date.now();
  return list.reduce((acc, c) => {
    const d = now - c.updatedAt;
    if      (d < 86400000)  acc.today.push(c);
    else if (d < 172800000) acc.yesterday.push(c);
    else if (d < 604800000) acc.week.push(c);
    else                    acc.older.push(c);
    return acc;
  }, { today: [], yesterday: [], week: [], older: [] });
}

// ── Usage tracking ──────────────────────────────────────────

function providerOf (model) {
  const sep = String(model || '').indexOf(':');
  if (sep > 0) {
    const p = model.slice(0, sep);
    if (PROVIDER_META[p]) return p;
  }
  return 'gemini';
}

function isVisionModel (model) {
  const m = String(model || '');
  return m.startsWith('gemini:') || m.includes('gpt-4o');
}

function todayKey () { return new Date().toISOString().slice(0, 10); }

function getUsage () {
  let u;
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); } catch { u = {}; }
  if (u.date !== todayKey()) u = { date: todayKey(), counts: {} };
  if (!u.counts) u.counts = {};
  return u;
}

function bumpUsage (provider) {
  const u = getUsage();
  u.counts[provider] = (u.counts[provider] || 0) + 1;
  localStorage.setItem(USAGE_KEY, JSON.stringify(u));
  renderUsage();
}

function msUntilMidnight () {
  const mid = new Date();
  mid.setHours(24, 0, 0, 0);
  return mid - Date.now();
}

function renderUsage () {
  const reset = document.getElementById('usage-reset');
  const body  = document.getElementById('usage-pop-body');
  if (!body) return;

  const ms = msUntilMidnight();
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  reset.textContent = `resets in ${h}h ${m}m`;

  const u      = getUsage();
  const active = providerOf(getSetting('model', DEFAULT_MODEL));

  body.innerHTML = '';
  for (const [key, meta] of Object.entries(PROVIDER_META)) {
    const used = u.counts[key] || 0;
    const pct  = Math.min(100, Math.round((used / meta.limit) * 100));
    const fill = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';

    const row = document.createElement('div');
    row.className = 'usage-row' + (key === active ? ' active' : '');
    row.innerHTML = `
      <div class="usage-row-top">
        <span class="usage-row-name">${meta.name}${key === active ? ' · active' : ''}</span>
        <span class="usage-row-count">${used} / ${meta.limit}</span>
      </div>
      <div class="usage-bar"><div class="usage-bar-fill ${fill}" style="width:${pct}%"></div></div>`;
    body.appendChild(row);
  }
}

// ── Sidebar rendering ───────────────────────────────────────

function renderSidebar (filter = '') {
  const list   = document.getElementById('conversation-list');
  const q      = (filter || document.getElementById('search-input').value).toLowerCase();
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const items  = q ? sorted.filter(c => c.title.toLowerCase().includes(q)) : sorted;

  list.innerHTML = '';

  if (!items.length) {
    const el = document.createElement('div');
    el.className = 'conv-empty';
    el.textContent = q ? 'No conversations match.' : 'No conversations yet.';
    list.appendChild(el);
    return;
  }

  const g = groupByDate(items);
  const add = (label, arr) => {
    if (!arr.length) return;
    const hdr = document.createElement('div');
    hdr.className = 'conv-group-header';
    hdr.textContent = label;
    list.appendChild(hdr);
    arr.forEach(c => list.appendChild(makeConvItem(c)));
  };
  add('Today',       g.today);
  add('Yesterday',   g.yesterday);
  add('Last 7 days', g.week);
  add('Older',       g.older);
}

function makeConvItem (conv) {
  const item = document.createElement('div');
  item.className   = 'conv-item' + (conv.id === activeId ? ' active' : '');
  item.role        = 'listitem';
  item.tabIndex    = 0;
  item.dataset.id  = conv.id;

  const content = document.createElement('div');
  content.className = 'conv-content';

  const title = document.createElement('div');
  title.className = 'conv-title';
  title.textContent = conv.title;

  const time = document.createElement('div');
  time.className = 'conv-time';
  time.textContent = relTime(conv.updatedAt);

  content.append(title, time);

  const del = document.createElement('button');
  del.className   = 'conv-delete';
  del.setAttribute('aria-label', `Delete "${conv.title}"`);
  del.innerHTML   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6M14 11v6"/>
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>`;

  del.addEventListener('click', e => {
    e.stopPropagation();
    showConfirm(
      'Delete Conversation',
      `Delete "${conv.title}"? This cannot be undone.`,
      () => deleteConv(conv.id),
    );
  });

  item.append(content, del);

  const activate = () => {
    if (!isStreaming) setActive(conv.id);
    closeMobileSidebar();
  };
  item.addEventListener('click', activate);
  item.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  });

  return item;
}

// ── Conversation activation ─────────────────────────────────

function setActive (id) {
  activeId = id;
  renderSidebar();
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  renderMessages(conv);
  setTitle(conv.title);
}

function setTitle (t) {
  document.getElementById('chat-title').textContent = t;
  document.title = t === 'New Conversation' ? 'Ember AI' : `${t} — Ember AI`;
}

function newChat () {
  if (isStreaming) return;
  const conv = makeConversation();
  conversations.unshift(conv);
  persistConversations();
  activeId = conv.id;
  renderSidebar();
  showWelcome();
  setTitle('New Conversation');
  document.getElementById('message-input').focus();
}

function deleteConv (id) {
  conversations = conversations.filter(c => c.id !== id);
  persistConversations();
  if (activeId === id) {
    if (conversations.length) {
      setActive([...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
    } else {
      activeId = null;
      showWelcome();
      setTitle('New Conversation');
    }
  }
  renderSidebar();
}

// ── Markdown rendering ──────────────────────────────────────

// Configure marked
marked.use({ breaks: true, gfm: true });

function esc (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMd (text) {
  const raw = marked.parse(text);

  // Post-process in a detached div
  const wrap = document.createElement('div');
  wrap.innerHTML = raw;

  // ── Code blocks: add header + syntax highlight ──
  wrap.querySelectorAll('pre > code').forEach(codeEl => {
    const pre  = codeEl.parentElement;
    const cls  = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
    const lang = cls ? cls.replace('language-', '') : '';

    // Syntax highlight
    try {
      if (lang && hljs.getLanguage(lang)) {
        codeEl.innerHTML = hljs.highlight(codeEl.textContent, { language: lang }).value;
      } else {
        codeEl.innerHTML = hljs.highlightAuto(codeEl.textContent).value;
      }
    } catch (_) {}
    codeEl.classList.add('hljs');

    // Header bar
    const hdr = document.createElement('div');
    hdr.className = 'code-header';
    hdr.innerHTML = `
      <span class="code-lang">${esc(lang || 'code')}</span>
      <button class="copy-code-btn" type="button" aria-label="Copy code">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>Copy
      </button>`;
    pre.insertBefore(hdr, codeEl);
  });

  // ── Wrap tables for horizontal scroll ──
  wrap.querySelectorAll('table').forEach(tbl => {
    const div = document.createElement('div');
    div.className = 'table-wrap';
    tbl.parentNode.insertBefore(div, tbl);
    div.appendChild(tbl);
  });

  return wrap.innerHTML;
}

// Event delegation for copy-code buttons (survives innerHTML re-sets)
document.addEventListener('click', e => {
  const btn = e.target.closest('.copy-code-btn');
  if (!btn) return;
  const code = btn.closest('pre')?.querySelector('code');
  if (!code) return;

  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.classList.add('copied');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"/></svg>Copied ✓`;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>Copy`;
    }, 2000);
  });
});

// ── Message feed ────────────────────────────────────────────

function showWelcome () {
  const feed = document.getElementById('message-feed');
  feed.innerHTML = `
    <div class="welcome-screen">
      <div class="welcome-logo">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C12 2 7 7 7 13C7 16.31 9.69 19 13 19C16.31 19 19 16.31 19 13C19 10 17 8 17 8C17 8 16 11 14 11C12 11 12 8 12 8C12 8 10 10 10 13C10 14.1 10.45 15.1 11.17 15.83C10.43 15.38 10 14.53 10 13.6C10 12.14 10.86 10.9 12 10.18V2Z" fill="currentColor"/>
        </svg>
      </div>
      <h2 class="welcome-heading">What would you like to explore?</h2>
      <div class="suggestion-grid">
        <button class="suggestion-card" data-prompt="Explain quantum computing in simple terms that anyone can understand">
          <span class="suggestion-icon">⚛️</span><span>Explain quantum computing simply</span>
        </button>
        <button class="suggestion-card" data-prompt="Write me a Python web scraper for a news website using requests and BeautifulSoup">
          <span class="suggestion-icon">🐍</span><span>Write me a Python web scraper</span>
        </button>
        <button class="suggestion-card" data-prompt="What are the best books on stoicism? Give me an annotated reading list.">
          <span class="suggestion-icon">📚</span><span>Best books on stoicism</span>
        </button>
        <button class="suggestion-card" data-prompt="Help me understand common JavaScript TypeError causes and how to debug them">
          <span class="suggestion-icon">🔧</span><span>Help me debug my JavaScript</span>
        </button>
      </div>
    </div>`;
  bindSuggestions();
}

function renderMessages (conv) {
  const feed = document.getElementById('message-feed');
  feed.innerHTML = '';
  if (!conv.messages.length) { showWelcome(); return; }
  conv.messages.forEach(m => appendMsg(m.role, m.content, false));
  scrollBottom(false);
}

function appendMsg (role, content, streaming) {
  const feed = document.getElementById('message-feed');

  // Remove welcome screen
  feed.querySelector('.welcome-screen')?.remove();

  const wrap = document.createElement('div');
  wrap.className = `message ${role === 'user' ? 'user-msg' : 'ai-msg'}`;

  const lbl = document.createElement('div');
  lbl.className = `msg-label ${role === 'user' ? '' : 'ai'}`;
  lbl.textContent = role === 'user' ? 'You' : 'Ember';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (role === 'user') {
    const imgs = messageImages(content);
    if (imgs.length) {
      const strip = document.createElement('div');
      strip.className = 'msg-images';
      imgs.forEach((src, i) => {
        const im = document.createElement('img');
        im.src = src; im.className = 'msg-image'; im.loading = 'lazy';
        im.alt = `attachment ${i + 1}`;
        strip.appendChild(im);
      });
      bubble.appendChild(strip);
    }
    const txt = messageText(content);
    if (txt) {
      const t = document.createElement('div');
      t.className = 'msg-text';
      t.textContent = txt;
      bubble.appendChild(t);
    }
  } else if (streaming) {
    bubble.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
    streamBubble = bubble;
  } else {
    bubble.innerHTML = renderMd(content);
  }

  wrap.append(lbl, bubble);
  feed.appendChild(wrap);

  if (!streaming) scrollBottom(false);
  return bubble;
}

function scrollBottom (smooth = true) {
  const f = document.getElementById('message-feed');
  f.scrollTo({ top: f.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

// ── Streaming ───────────────────────────────────────────────

async function sendMessage (text) {
  text = (text || '').trim();
  if (isStreaming) return;
  if (!text && !pendingImages.length) return;

  const workerUrl = getSetting('workerUrl', DEFAULT_WORKER_URL);
  if (!workerUrl) { promptWorkerUrl(); return; }

  const model  = getSetting('model', DEFAULT_MODEL);
  const images = pendingImages.slice();

  // Vision guard — images only work on multimodal models (Gemini, GPT-4o)
  if (images.length && !isVisionModel(model)) {
    toast('Images need a vision model — switch to Gemini or GPT-4o in Settings.');
    return;
  }

  // Message content: a plain string, or an array of parts when images attached
  let msgContent = text;
  if (images.length) {
    msgContent = [];
    if (text) msgContent.push({ type: 'text', text });
    images.forEach(url => msgContent.push({ type: 'image_url', image_url: { url } }));
  }

  // Ensure an active conversation
  if (!activeId) {
    const conv = makeConversation();
    conversations.unshift(conv);
    activeId = conv.id;
  }
  const conv = getActive();
  if (!conv) return;

  // Clear pending images now that we're committed to sending
  pendingImages = [];
  renderImagePreview();

  // Record user message
  conv.messages.push({ role: 'user', content: msgContent });
  if (conv.messages.length === 1) {
    conv.title = autoTitle(messageText(msgContent));
    setTitle(conv.title);
  }
  conv.updatedAt = Date.now();

  appendMsg('user', msgContent, false);

  // Clear input
  const inp = document.getElementById('message-input');
  inp.value = '';
  autoResize(inp);
  updateSendBtn();

  // AI bubble (loading state)
  appendMsg('assistant', '', true);

  setStreaming(true);
  streamBuf = '';

  // Build request body
  const payload = {
    model:      model,
    messages:   [
      { role: 'system', content: getSetting('systemPrompt', DEFAULT_SYSTEM_PROMPT) },
      ...conv.messages,
    ],
    stream:     true,
    temperature: getSetting('temperature', 0.7),
    max_tokens:  getSetting('maxTokens',   2048),
  };

  // Slow-thinking notice
  slowTimer = setTimeout(() => {
    if (streamBubble) {
      const n = document.createElement('div');
      n.className   = 'slow-notice';
      n.textContent = 'Still thinking…';
      streamBubble.appendChild(n);
    }
  }, SLOW_TIMEOUT);

  abortCtrl = new AbortController();

  try {
    const resp = await fetch(workerUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  abortCtrl.signal,
    });

    // Count this request against the active provider's daily quota estimate
    bumpUsage(providerOf(payload.model));

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      const msg = resp.status === 429
        ? 'The model is rate-limited right now. Please wait a moment and try again.'
        : `API error ${resp.status}: ${txt || 'Unknown error'}`;
      showError(streamBubble, msg, false);
      conv.messages.pop();
      persistConversations();
      return;
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let   linesBuf = '';
    let   firstToken = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      linesBuf += decoder.decode(value, { stream: true });
      const lines = linesBuf.split('\n');
      linesBuf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const json  = JSON.parse(raw);
          const token = json.choices?.[0]?.delta?.content;
          if (!token) continue;

          if (firstToken) {
            clearTimeout(slowTimer);
            if (streamBubble) streamBubble.innerHTML = '';
            firstToken = false;
          }

          streamBuf += token;
          scheduleRender();
        } catch (_) {}
      }
    }

    // Final render (no cursor)
    clearTimeout(renderTimer);
    renderTimer = null;
    if (streamBubble) streamBubble.innerHTML = renderMd(streamBuf);

    // Persist
    conv.messages.push({ role: 'assistant', content: streamBuf });
    conv.updatedAt = Date.now();
    persistConversations();
    renderSidebar();

  } catch (err) {
    clearTimeout(slowTimer);

    if (err.name === 'AbortError') {
      // User aborted — keep whatever was streamed
      clearTimeout(renderTimer);
      renderTimer = null;
      if (streamBuf) {
        if (streamBubble) streamBubble.innerHTML = renderMd(streamBuf);
        conv.messages.push({ role: 'assistant', content: streamBuf });
        conv.updatedAt = Date.now();
        persistConversations();
        renderSidebar();
      } else {
        // Nothing streamed — remove the AI bubble and user message
        document.querySelector('#message-feed .message:last-child')?.remove();
        conv.messages.pop();
        persistConversations();
      }
    } else {
      conv.messages.pop();
      persistConversations();
      showError(streamBubble, 'Failed to reach the AI. Check your Worker URL in Settings or try again.', true);
    }
  } finally {
    clearTimeout(slowTimer);
    setStreaming(false);
    streamBubble = null;
    streamBuf    = '';
    scrollBottom();
  }
}

function scheduleRender () {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (!streamBubble || !streamBuf) return;
    streamBubble.innerHTML = renderMd(streamBuf);
    // Append blinking cursor as last child
    const cur = document.createElement('span');
    cur.className = 'stream-cursor';
    streamBubble.appendChild(cur);
    scrollBottom(false);
  }, RENDER_TICK);
}

function setStreaming (on) {
  isStreaming = on;
  const inp  = document.getElementById('message-input');
  const send = document.getElementById('send-btn');
  const stop = document.getElementById('stop-wrapper');

  inp.disabled = on;
  if (on) {
    send.style.display = 'none';
    stop.classList.add('visible');
  } else {
    send.style.display = '';
    stop.classList.remove('visible');
    inp.focus();
    updateSendBtn();
    document.querySelectorAll('.stream-cursor').forEach(c => c.remove());
  }
}

function showError (bubble, msg, canRetry) {
  if (!bubble) return;
  bubble.innerHTML = `<div class="error-card">
    ${esc(msg)}
    ${canRetry ? '<br><button class="retry-btn" onclick="retryLast()">Retry</button>' : ''}
  </div>`;
}

function retryLast () {
  const conv = getActive();
  if (!conv || !conv.messages.length) return;

  // Find last user message
  let idx = conv.messages.length - 1;
  while (idx >= 0 && conv.messages[idx].role !== 'user') idx--;
  if (idx < 0) return;

  const userContent = conv.messages[idx].content;
  conv.messages = conv.messages.slice(0, idx);
  persistConversations();

  // Re-render without failed messages
  renderMessages(conv);
  sendMessage(userContent);
}

function promptWorkerUrl () {
  openSettings();
  setTimeout(() => {
    const s = document.getElementById('conn-status');
    s.textContent = '⚠ Enter your Cloudflare Worker URL to start chatting.';
    s.className   = 'conn-status err';
    document.getElementById('worker-url').focus();
  }, 150);
}

// ── Input helpers ───────────────────────────────────────────

function autoResize (el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

function updateSendBtn () {
  const hasText = document.getElementById('message-input').value.trim();
  document.getElementById('send-btn').disabled = !(hasText || pendingImages.length);
}

// ── Theme ───────────────────────────────────────────────────

function applyTheme (theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);

  const hlLink = document.getElementById('hljs-theme');
  hlLink.href = theme === 'light'
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';

  const settBtn = document.getElementById('settings-theme-btn');
  if (settBtn) settBtn.textContent = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
}

function toggleTheme () {
  const next = getSetting('theme', 'dark') === 'dark' ? 'light' : 'dark';
  setSetting('theme', next);
  applyTheme(next);
}

// ── Settings ────────────────────────────────────────────────

function openSettings () {
  document.getElementById('settings-panel').classList.add('open');
  syncSettingsToUI();
}

function closeSettings () {
  document.getElementById('settings-panel').classList.remove('open');
}

function syncSettingsToUI () {
  const s = getSettings();
  document.getElementById('worker-url').value  = s.workerUrl  || DEFAULT_WORKER_URL;
  document.getElementById('model-select').value = s.model     || DEFAULT_MODEL;
  document.getElementById('sys-prompt').value   = s.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const temp = s.temperature ?? 0.7;
  document.getElementById('temp-slider').value  = temp;
  document.getElementById('temp-value').textContent = temp;

  const tok = s.maxTokens ?? 2048;
  document.getElementById('tokens-slider').value = tok;
  document.getElementById('tokens-value').textContent = tok;

  applyTheme(s.theme || 'dark');
}

function saveSettingsFromUI () {
  setSetting('workerUrl',    document.getElementById('worker-url').value.trim());
  setSetting('model',        document.getElementById('model-select').value);
  setSetting('systemPrompt', document.getElementById('sys-prompt').value);
  setSetting('temperature',  parseFloat(document.getElementById('temp-slider').value));
  setSetting('maxTokens',    parseInt(document.getElementById('tokens-slider').value, 10));
}

async function testConnection () {
  const url = document.getElementById('worker-url').value.trim();
  const status = document.getElementById('conn-status');

  if (!url) {
    status.textContent = '✗ Please enter a Worker URL first.';
    status.className   = 'conn-status err';
    return;
  }

  status.textContent = 'Testing…';
  status.className   = 'conn-status';

  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:      document.getElementById('model-select').value || DEFAULT_MODEL,
        messages:   [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        stream:     false,
      }),
    });
    if (r.ok) {
      status.textContent = '✓ Connected successfully!';
      status.className   = 'conn-status ok';
    } else {
      const t = await r.text().catch(() => '');
      status.textContent = `✗ Error ${r.status}: ${t || 'check Worker logs'}`;
      status.className   = 'conn-status err';
    }
  } catch (e) {
    status.textContent = `✗ Failed: ${e.message}`;
    status.className   = 'conn-status err';
  }
}

function exportConversations () {
  const blob = new Blob([JSON.stringify(conversations, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `ember-conversations-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

function clearAll () {
  showConfirm(
    'Clear All Conversations',
    `This will permanently delete all ${conversations.length} conversation${conversations.length === 1 ? '' : 's'}. This cannot be undone.`,
    () => {
      conversations = [];
      persistConversations();
      activeId = null;
      renderSidebar();
      showWelcome();
      setTitle('New Conversation');
      closeSettings();
    },
  );
}

// ── Confirm modal ───────────────────────────────────────────

function showConfirm (title, msg, cb) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent   = msg;
  document.getElementById('confirm-ok').textContent    = 'Delete';
  confirmCb = cb;
  document.getElementById('confirm-modal').classList.add('open');
}

function closeConfirm () {
  document.getElementById('confirm-modal').classList.remove('open');
  confirmCb = null;
}

// ── Copy conversation ───────────────────────────────────────

function copyConversation () {
  const conv = getActive();
  if (!conv) return;
  const md = conv.messages
    .map(m => {
      const imgs = messageImages(m.content);
      const tag  = imgs.length ? ` _(+${imgs.length} image${imgs.length > 1 ? 's' : ''})_` : '';
      return `**${m.role === 'user' ? 'You' : 'Ember'}:**${tag}\n\n${messageText(m.content)}`;
    })
    .join('\n\n---\n\n');
  navigator.clipboard.writeText(md).then(() => {
    const btn  = document.getElementById('copy-convo-btn');
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => btn.innerHTML = orig, 2000);
  });
}

// ── Sidebar collapse / mobile ───────────────────────────────

function openMobileSidebar () {
  document.getElementById('sidebar').classList.add('mobile-open');
  document.getElementById('sidebar-overlay').classList.add('active');
}

function closeMobileSidebar () {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('active');
}

// ── Suggestion cards ────────────────────────────────────────

function bindSuggestions () {
  document.querySelectorAll('.suggestion-card').forEach(card => {
    card.addEventListener('click', () => {
      const inp = document.getElementById('message-input');
      inp.value = card.dataset.prompt;
      autoResize(inp);
      updateSendBtn();
      handleSend();
    });
  });
}

// ── Attachments + toast ─────────────────────────────────────

function fileToDataURL (file, maxDim = MAX_IMAGE_DIM) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const s = Math.min(maxDim / width, maxDim / height);
        width  = Math.round(width  * s);
        height = Math.round(height * s);
      }
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      c.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

async function addImages (fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/'));
  for (const f of files) {
    if (pendingImages.length >= 6) { toast('Up to 6 images per message.'); break; }
    try { pendingImages.push(await fileToDataURL(f)); } catch { toast('Skipped an unreadable image.'); }
  }
  renderImagePreview();
  updateSendBtn();
}

function renderImagePreview () {
  const strip = document.getElementById('image-preview');
  if (!strip) return;
  strip.innerHTML = '';
  strip.classList.toggle('visible', pendingImages.length > 0);
  pendingImages.forEach((src, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';
    thumb.innerHTML = `<img src="${src}" alt="attachment ${i + 1}">
      <button class="preview-remove" data-i="${i}" aria-label="Remove image">&times;</button>`;
    strip.appendChild(thumb);
  });
}

let toastTimer = null;
function toast (msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ── Send handler ────────────────────────────────────────────

function handleSend () {
  if (isStreaming) return;
  const inp = document.getElementById('message-input');
  const txt = inp.value.trim();
  if (!txt && !pendingImages.length) return;
  sendMessage(txt);
}

// ── Scroll-to-bottom button ─────────────────────────────────

function setupScrollBtn () {
  const feed = document.getElementById('message-feed');
  const btn  = document.getElementById('scroll-bottom-btn');
  feed.addEventListener('scroll', () => {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    btn.classList.toggle('visible', !atBottom);
  });
  btn.addEventListener('click', () => scrollBottom());
}

// ── Init ────────────────────────────────────────────────────

function init () {
  loadConversations();

  // Migrate any pre-existing bare model id (e.g. "gemini-2.5-flash") to the
  // new "provider:model" format so routing + usage work.
  const savedModel = getSetting('model', null);
  if (savedModel && !savedModel.includes(':')) setSetting('model', 'gemini:' + savedModel);

  // Apply saved theme
  applyTheme(getSetting('theme', 'dark'));

  // Load most-recent conversation or welcome
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  if (sorted.length) {
    setActive(sorted[0].id);
  } else {
    showWelcome();
  }
  renderSidebar();

  // ── Input ──
  const inp = document.getElementById('message-input');
  inp.addEventListener('input', () => { autoResize(inp); updateSendBtn(); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  document.getElementById('send-btn').addEventListener('click', handleSend);
  document.getElementById('stop-btn').addEventListener('click', () => abortCtrl?.abort());
  document.getElementById('new-chat-btn').addEventListener('click', newChat);

  // ── Image attachments ──
  const fileInput = document.getElementById('file-input');
  document.getElementById('attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async e => {
    await addImages(e.target.files);
    fileInput.value = '';
  });
  document.getElementById('image-preview').addEventListener('click', e => {
    const btn = e.target.closest('.preview-remove');
    if (!btn) return;
    pendingImages.splice(Number(btn.dataset.i), 1);
    renderImagePreview();
    updateSendBtn();
  });

  // ── Search ──
  document.getElementById('search-input').addEventListener('input', e => {
    renderSidebar(e.target.value.toLowerCase());
  });

  // ── Copy conversation ──
  document.getElementById('copy-convo-btn').addEventListener('click', copyConversation);

  // ── Editable title ──
  const titleEl = document.getElementById('chat-title');
  titleEl.addEventListener('blur', () => {
    const conv = getActive();
    if (!conv) return;
    conv.title = titleEl.textContent.trim() || 'New Conversation';
    setTitle(conv.title);
    persistConversations();
    renderSidebar();
  });
  titleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  });

  // ── Theme toggle (sidebar) ──
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // ── Settings open / close ──
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', () => {
    saveSettingsFromUI();
    closeSettings();
  });
  document.getElementById('settings-backdrop').addEventListener('click', () => {
    saveSettingsFromUI();
    closeSettings();
  });

  // Settings inputs — auto-save on change
  ['worker-url', 'model-select', 'sys-prompt'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromUI);
  });
  // Model change also updates which provider is highlighted as "active" in usage
  document.getElementById('model-select').addEventListener('change', renderUsage);

  // Sliders — live display + save on change
  document.getElementById('temp-slider').addEventListener('input', e => {
    document.getElementById('temp-value').textContent = e.target.value;
  });
  document.getElementById('temp-slider').addEventListener('change', saveSettingsFromUI);

  document.getElementById('tokens-slider').addEventListener('input', e => {
    document.getElementById('tokens-value').textContent = e.target.value;
  });
  document.getElementById('tokens-slider').addEventListener('change', saveSettingsFromUI);

  // Test connection
  document.getElementById('test-conn-btn').addEventListener('click', testConnection);

  // Reset system prompt
  document.getElementById('reset-prompt-btn').addEventListener('click', () => {
    document.getElementById('sys-prompt').value = DEFAULT_SYSTEM_PROMPT;
    saveSettingsFromUI();
  });

  // Settings theme toggle
  document.getElementById('settings-theme-btn').addEventListener('click', () => {
    toggleTheme();
    document.getElementById('settings-theme-btn').textContent =
      getSetting('theme', 'dark') === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  });

  // Export / clear
  document.getElementById('export-btn').addEventListener('click', exportConversations);
  document.getElementById('clear-all-btn').addEventListener('click', clearAll);

  // ── Confirm modal ──
  document.getElementById('confirm-ok').addEventListener('click', () => {
    confirmCb?.();
    closeConfirm();
  });
  document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('modal-backdrop').addEventListener('click', closeConfirm);

  // ── Sidebar collapse (desktop) ──
  const sidebar    = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('sidebar-collapse');
  const openBtn    = document.getElementById('sidebar-open');
  const overlay    = document.getElementById('sidebar-overlay');

  collapseBtn.addEventListener('click', () => {
    if (window.innerWidth <= 768) { closeMobileSidebar(); return; }
    sidebar.classList.toggle('collapsed');
    openBtn.style.display = sidebar.classList.contains('collapsed') ? 'flex' : 'none';
  });

  openBtn.addEventListener('click', () => {
    if (window.innerWidth <= 768) { openMobileSidebar(); return; }
    sidebar.classList.remove('collapsed');
    openBtn.style.display = 'none';
  });

  overlay.addEventListener('click', closeMobileSidebar);

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      overlay.classList.remove('active');
      sidebar.classList.remove('mobile-open');
    }
  });

  // ── Scroll button ──
  setupScrollBtn();

  // ── Usage popover ──
  const usageBtn = document.getElementById('usage-btn');
  const usagePop = document.getElementById('usage-popover');
  usageBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = usagePop.classList.toggle('open');
    if (open) renderUsage();
  });
  document.addEventListener('click', e => {
    if (usagePop.classList.contains('open') &&
        !usagePop.contains(e.target) && !usageBtn.contains(e.target)) {
      usagePop.classList.remove('open');
    }
  });
  renderUsage();

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      closeSettings(); closeConfirm(); closeMobileSidebar();
      usagePop.classList.remove('open');
    }
    if (mod && e.key === 'n') { e.preventDefault(); newChat(); }
    if (mod && e.key === 'k') { e.preventDefault(); document.getElementById('search-input').focus(); }
  });

  // Refresh relative times + usage countdown every 60 s
  setInterval(() => { renderSidebar(); if (usagePop.classList.contains('open')) renderUsage(); }, 60000);
}

document.addEventListener('DOMContentLoaded', init);
