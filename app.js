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
const REQUIRE_PASSPHRASE = true;       // show a lock screen until the passphrase is verified
const PASS_KEY = 'ember_passphrase';

// Provider display names + approximate free daily request limits (for the local
// usage estimate — providers don't expose live quota, so this counts requests
// this browser made today). Limits are ballpark and easy to tweak.
const PROVIDER_META = {
  gemini:     { name: 'Google Gemini', limit: 1500 },
  groq:       { name: 'Groq',          limit: 1000 },
  github:     { name: 'GitHub Models',  limit: 150 },
  openrouter: { name: 'OpenRouter',     limit: 200 },
};

// Always prepended to whatever prompt/persona is active, so Ember knows itself.
const EMBER_IDENTITY =
`About yourself (use this only when the user asks about Ember, who made it, the website, what model you are, etc. — otherwise don't bring it up):
- You are Ember, the AI assistant inside "Ember AI", a free, open-source chat web app.
- Ember AI was created by ToxinNozaki and is hosted at https://toxinnozaki.github.io/ember-ai/ (source code: https://github.com/ToxinNozaki/ember-ai).
- The app is free and routes through several free AI providers (Google Gemini, Groq, GitHub Models, OpenRouter). The user picks which one, so your underlying model varies — if asked which model powers you and you don't know, say it depends on the model selected in the app.
- Do NOT claim the Ember AI app was made by OpenAI, Meta, Google, Anthropic, etc. Those companies make the underlying language models; the Ember AI app itself was built by ToxinNozaki.
- Conversations are stored only in the user's own browser (localStorage); nothing is saved on a server.
Keep this brief and only mention it when relevant.`;

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

const DIRECT_MODE_PROMPT =
`You are Ember, a direct and capable AI assistant for an adult user. Treat the user as a competent adult who does not need to be managed, warned, or talked down to.

Behavior:
- Answer the exact question asked, directly and completely. Do not hedge, soften, or pad.
- Do not moralize, editorialize, or add unsolicited warnings, disclaimers, or "be careful" notes. If the user wants caveats, they will ask for them.
- Engage factually with controversial, sensitive, mature, or uncomfortable topics — history, politics, security concepts, drugs and harm reduction, medicine, relationships, dark or violent fiction, and so on. Present the information plainly and let the user draw their own conclusions.
- Do not refuse a benign-but-edgy request just because the topic sounds sensitive. Default to being helpful.
- Skip reflexive phrases like "I can't help with that," "I'm just an AI," "it's important to note," and "consult a professional" unless that genuinely is the substance of the answer.
- You may still decline things that would materially help cause serious real-world harm (e.g. building weapons or malware) — but do not treat ordinary mature or controversial subjects as if they were dangerous.

Formatting rules you ALWAYS follow:
- Use **bold** for key terms and *italics* for emphasis.
- Use bullet points (- ) for lists of 3 or more items, and numbered lists for steps or rankings.
- Use ### headers to organize long answers and horizontal dividers (---) to separate major sections.
- Use tables when comparing multiple things across attributes.
- Use \`inline code\` for short snippets/commands, and triple-backtick code blocks with the correct language label for any code longer than one line.

Be concise. Prefer short sentences. Never pad with filler.`;

// ── Personalities (Grok-style presets) ──────────────────────
// Each is a system-prompt persona. "default" uses the user's own prompt.
const PERSONAS = [
  { id: 'default',    label: '✦ Default',           prompt: null },
  { id: 'therapist',  label: '🛋️ Therapist',        prompt: `You are Ember in Therapist mode: a warm, empathetic, non-judgmental listener. Reflect the user's feelings back to them, ask gentle open-ended questions, and validate emotions before offering perspective. Don't rush to fix things. Keep a calm, human tone. You are not a replacement for a licensed professional, and if someone is in crisis, gently encourage real help.` },
  { id: 'doctor',     label: '🩺 Doctor',            prompt: `You are Ember in Doctor mode: a clear, knowledgeable medical explainer. Explain symptoms, conditions, medications, and treatments in plain language with accurate, up-to-date information. Be direct and practical. For anything that needs diagnosis, prescriptions, or could be an emergency, tell the user to see a real clinician.` },
  { id: 'professor',  label: '🎓 Professor',         prompt: `You are Ember in Professor mode: an erudite, patient academic. Give thorough, well-structured explanations with context, history, examples, and nuance. Show your reasoning. Use headers, lists, and the occasional analogy to make complex ideas click.` },
  { id: 'romantic',   label: '🌹 Romantic',          prompt: `You are Ember in Romantic mode: a charming, affectionate, poetic companion. Be warm, playful, and tender, with expressive language and sweet compliments. Keep it tasteful and PG-13.` },
  { id: 'comedian',   label: '🎤 Comedian',          prompt: `You are Ember in Comedian mode: a witty, irreverent stand-up comic. Answer with jokes, wordplay, and great comic timing while still being genuinely helpful underneath the bit. Keep it clever, not mean.` },
  { id: 'coach',      label: '💪 Coach',             prompt: `You are Ember in Coach mode: a high-energy, motivational coach. Be direct, encouraging, and action-oriented. Break goals into concrete steps, hold the user accountable, and hype them up. No fluff — momentum.` },
  { id: 'chef',       label: '👨‍🍳 Chef',             prompt: `You are Ember in Chef mode: a passionate culinary expert. Share recipes, techniques, flavor pairings, and plating tips with enthusiasm and precision. Offer substitutions and scaling. Make the user excited to cook.` },
  { id: 'conspiracy', label: '🛸 Conspiracy Theorist', prompt: `You are Ember in Conspiracy Theorist mode: a wildly entertaining character who sees hidden patterns everywhere and dramatically connects unlikely dots ("wake up — it's all connected!"). This is theatrical roleplay for fun. Lean into the bit with humor and flair, but keep it as entertainment — don't present genuinely harmful real-world misinformation (medical, election, etc.) as actual fact.` },
];
const PERSONAS_MAP = Object.fromEntries(PERSONAS.map(p => [p.id, p]));

// "How hard the AI works" — maps an effort level to generation params.
function effortParams () {
  const e = getSetting('effort', 'balanced');
  if (e === 'fast') return { temperature: 0.3, max_tokens: 1024 };
  if (e === 'max')  return { temperature: 0.9, max_tokens: 4096 };
  return { temperature: getSetting('temperature', 0.7), max_tokens: getSetting('maxTokens', 2048) };
}

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
  updateUsagePill();
}

function updateUsagePill () {
  const pill = document.getElementById('usage-pill');
  if (!pill) return;
  const p    = providerOf(getSetting('model', DEFAULT_MODEL));
  const meta = PROVIDER_META[p];
  const used = getUsage().counts[p] || 0;
  const pct  = used / meta.limit;
  const dot  = pct >= 1 ? '🔴' : pct >= 0.8 ? '🟠' : '🟢';
  pill.textContent = `${dot} ${used}/${meta.limit}`;
  pill.title = `${meta.name}: ${used} of ~${meta.limit} free requests used today`;
}

// ── GitHub profile ──────────────────────────────────────────

async function loadGithubProfile (force) {
  const user = String(getSetting('githubUser', '') || '').trim();
  if (!user) { setSetting('githubProfile', null); updateAvatar(); renderProfile(); return; }

  const cached = getSetting('githubProfile', null);
  if (!force && cached && cached.login && cached.login.toLowerCase() === user.toLowerCase()) {
    updateAvatar(); renderProfile(); return;
  }
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}`);
    if (!r.ok) throw new Error(r.status === 404 ? 'username not found' : `error ${r.status}`);
    const d = await r.json();
    setSetting('githubProfile', {
      login: d.login, name: d.name || d.login, avatar_url: d.avatar_url, html_url: d.html_url,
    });
    updateAvatar(); renderProfile();
    if (force) toast('GitHub profile linked.');
  } catch (e) {
    toast('GitHub: ' + e.message);
  }
}

function updateAvatar () {
  const el = document.getElementById('user-avatar');
  if (!el) return;
  const prof = getSetting('githubProfile', null);
  if (prof && prof.avatar_url) {
    el.innerHTML = `<img src="${prof.avatar_url}" alt="${esc(prof.login)}">`;
    el.classList.add('has-img');
    el.setAttribute('aria-label', `GitHub: ${prof.login}`);
  } else {
    el.textContent = 'U';
    el.classList.remove('has-img');
    el.setAttribute('aria-label', 'User profile');
  }
}

function renderProfile () {
  const body = document.getElementById('profile-pop-body');
  if (!body) return;
  const prof = getSetting('githubProfile', null);
  if (!prof) {
    body.innerHTML = `<div class="profile-empty">Add your GitHub username in <strong>Settings</strong> to show your profile here.</div>`;
    return;
  }
  body.innerHTML = `
    <img class="profile-avatar" src="${prof.avatar_url}" alt="${esc(prof.login)}">
    <div class="profile-name">${esc(prof.name)}</div>
    <a class="profile-link" href="${prof.html_url}" target="_blank" rel="noopener noreferrer">@${esc(prof.login)} ↗</a>`;
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

  // Hover action bar for AI messages (Copy + Regenerate), like Claude
  if (role !== 'user') {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `
      <button class="msg-action" data-act="copy" title="Copy message" aria-label="Copy message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="msg-action" data-act="regen" title="Regenerate response" aria-label="Regenerate response">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>`;
    wrap.appendChild(actions);
  }

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

  // Build request body — persona overrides the base prompt; effort sets params.
  // Ember's self-knowledge is prepended to every prompt so it knows what it is.
  const persona    = PERSONAS_MAP[getSetting('personality', 'default')];
  const basePrompt = (persona && persona.prompt) ? persona.prompt : getSetting('systemPrompt', DEFAULT_SYSTEM_PROMPT);
  const sysPrompt  = EMBER_IDENTITY + '\n\n' + basePrompt;
  const eff        = effortParams();

  const payload = {
    model:       model,
    messages:    [
      { role: 'system', content: sysPrompt },
      ...conv.messages,
    ],
    stream:      true,
    temperature: eff.temperature,
    max_tokens:  eff.max_tokens,
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
      headers: authHeaders(),
      body:    JSON.stringify(payload),
      signal:  abortCtrl.signal,
    });

    // Locked — passphrase missing or wrong
    if (resp.status === 401) {
      localStorage.removeItem(PASS_KEY);
      persistConversations(); // keep the user message
      showError(streamBubble, 'Locked — enter the passphrase to continue.', false);
      showGate('Enter the passphrase to continue.');
      return;
    }

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      let detail = txt;
      try { detail = JSON.parse(txt)?.error?.message || txt; } catch {}
      const msg = resp.status === 429
        ? 'The model is rate-limited right now. Wait a moment and retry, or switch models in Settings.'
        : `API error ${resp.status}: ${detail || 'Unknown error'}`;
      showError(streamBubble, msg, true);
      persistConversations(); // keep the user message so Retry works
      return;
    }

    // Count this request against the active provider's daily quota estimate
    bumpUsage(providerOf(payload.model));

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

    if (!streamBuf.trim()) {
      // Model returned nothing usable — offer retry instead of an empty bubble
      showError(streamBubble, 'The model returned an empty response. Retry, or switch models in Settings.', true);
      persistConversations(); // keep the user message for retry
      return;
    }

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
    ${canRetry ? '<br><button class="retry-btn" data-act="retry" type="button">Retry</button>' : ''}
  </div>`;
}

function retryLast () {
  const conv = getActive();
  if (!conv || !conv.messages.length) return;

  // Find last user message
  let idx = conv.messages.length - 1;
  while (idx >= 0 && conv.messages[idx].role !== 'user') idx--;
  if (idx < 0) return;

  const last = conv.messages[idx].content;
  const text = messageText(last);
  const imgs = messageImages(last);
  conv.messages = conv.messages.slice(0, idx);
  persistConversations();

  // Re-render without the failed exchange, then resend (re-attaching any images)
  renderMessages(conv);
  if (imgs.length) { pendingImages = imgs.slice(); renderImagePreview(); }
  sendMessage(text);
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

// ── Passphrase gate ─────────────────────────────────────────

function authHeaders () {
  const h = { 'Content-Type': 'application/json' };
  const p = localStorage.getItem(PASS_KEY);
  if (p) h['X-Ember-Passphrase'] = p;
  return h;
}

// Returns: true (accepted), false (401 wrong), 'unknown' (worker reachable but
// doesn't gate / pre-gate worker), or null (network failure).
async function pingAuth (pass) {
  const url = getSetting('workerUrl', DEFAULT_WORKER_URL);
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...(pass ? { 'X-Ember-Passphrase': pass } : {}) },
      body:    JSON.stringify({ ping: true }),
    });
    if (r.status === 401) return false;
    if (r.ok) return true;
    return 'unknown';
  } catch { return null; }
}

function showGate (msg) {
  const g = document.getElementById('gate');
  g.classList.remove('hidden');
  document.getElementById('gate-error').textContent = msg || '';
  setTimeout(() => document.getElementById('gate-input')?.focus(), 50);
}

function hideGate () { document.getElementById('gate').classList.add('hidden'); }

async function submitGate () {
  const input = document.getElementById('gate-input');
  const err   = document.getElementById('gate-error');
  const pass  = input.value;
  if (!pass) { err.textContent = 'Enter the passphrase.'; return; }

  err.textContent = 'Checking…';
  const ok = await pingAuth(pass);
  if (ok === false) { err.textContent = 'Wrong passphrase. Try again.'; return; }
  if (ok === null)  { err.textContent = 'Could not reach the server. Check your connection.'; return; }

  // true or 'unknown' → accept (server enforces the real check on each request)
  localStorage.setItem(PASS_KEY, pass);
  hideGate();
  input.value = '';
  err.textContent = '';
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
  document.getElementById('github-user').value = s.githubUser || '';
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
  setSetting('githubUser',   document.getElementById('github-user').value.trim());
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
      headers: authHeaders(),
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
    } else if (r.status === 401) {
      status.textContent = '✗ Passphrase required or incorrect (unlock the site first).';
      status.className   = 'conn-status err';
    } else {
      const t = await r.text().catch(() => '');
      let detail = t;
      try { detail = JSON.parse(t)?.error?.message || t; } catch {}
      status.textContent = `✗ Error ${r.status}: ${detail || 'check Worker logs'}`;
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

// ── Bottom toolbar (model / effort / persona / usage / voice) ──

function flashAction (btn) {
  btn.classList.add('done');
  setTimeout(() => btn.classList.remove('done'), 1500);
}

function setModel (value) {
  setSetting('model', value);
  const a = document.getElementById('model-select');
  const b = document.getElementById('model-quick');
  if (a) a.value = value;
  if (b) b.value = value;
  renderUsage();
}

function setupToolbar () {
  // Personas
  const persona = document.getElementById('persona-select');
  persona.innerHTML = PERSONAS.map(p => `<option value="${p.id}">${p.label}</option>`).join('');
  persona.value = getSetting('personality', 'default');
  persona.addEventListener('change', () => {
    setSetting('personality', persona.value);
    const p = PERSONAS_MAP[persona.value];
    toast(persona.value === 'default' ? 'Using your custom prompt.' : `Personality: ${p.label.replace(/^\S+\s/, '')}`);
  });

  // Model quick-switch (mirrors the Settings dropdown)
  const quick = document.getElementById('model-quick');
  quick.innerHTML = document.getElementById('model-select').innerHTML;
  quick.value = getSetting('model', DEFAULT_MODEL);
  quick.addEventListener('change', () => setModel(quick.value));

  // Effort
  const effort = document.getElementById('effort-select');
  effort.value = getSetting('effort', 'balanced');
  effort.addEventListener('change', () => setSetting('effort', effort.value));

  updateUsagePill();
}

function initVoice () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('mic-btn');
  if (!SR) { micBtn.style.display = 'none'; return; } // unsupported browser

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  let listening = false;
  let baseText  = '';

  rec.onresult = e => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t; else interim += t;
    }
    if (final) baseText += final;
    const inp = document.getElementById('message-input');
    inp.value = (baseText + interim).replace(/\s+/g, ' ').trimStart();
    autoResize(inp);
    updateSendBtn();
  };
  const stop = () => { listening = false; micBtn.classList.remove('listening'); };
  rec.onend = stop;
  rec.onerror = ev => { if (ev.error === 'not-allowed') toast('Microphone permission denied.'); stop(); };

  micBtn.addEventListener('click', () => {
    if (listening) { rec.stop(); return; }
    baseText = document.getElementById('message-input').value;
    if (baseText && !baseText.endsWith(' ')) baseText += ' ';
    try { rec.start(); listening = true; micBtn.classList.add('listening'); }
    catch { /* already started */ }
  });
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

  // ── Passphrase gate ──
  if (REQUIRE_PASSPHRASE && !localStorage.getItem(PASS_KEY)) showGate(); else hideGate();
  document.getElementById('gate-submit').addEventListener('click', submitGate);
  document.getElementById('gate-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitGate(); }
  });

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
  // Model change also updates the quick-switcher + usage highlight
  document.getElementById('model-select').addEventListener('change', () => {
    const q = document.getElementById('model-quick');
    if (q) q.value = document.getElementById('model-select').value;
    renderUsage();
  });

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
    toast('System prompt reset to default.');
  });

  // Direct Mode preset
  document.getElementById('direct-mode-btn').addEventListener('click', () => {
    document.getElementById('sys-prompt').value = DIRECT_MODE_PROMPT;
    saveSettingsFromUI();
    toast('Direct Mode on — straight answers, no moralizing.');
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

  // ── Bottom toolbar + voice ──
  setupToolbar();
  initVoice();

  // ── Message hover actions (Copy / Regenerate) + error Retry ──
  document.getElementById('message-feed').addEventListener('click', e => {
    const act = e.target.closest('.msg-action, .retry-btn');
    if (!act) return;
    const kind = act.dataset.act;
    if (kind === 'copy') {
      const bub = act.closest('.message')?.querySelector('.msg-bubble');
      if (bub) { navigator.clipboard.writeText(bub.innerText.trim()); flashAction(act); }
    } else if (kind === 'regen' || kind === 'retry') {
      if (!isStreaming) retryLast();
    }
  });

  // ── Usage popover ──
  const usageBtn = document.getElementById('usage-btn');
  const usagePop = document.getElementById('usage-popover');
  usageBtn.addEventListener('click', e => {
    e.stopPropagation();
    profilePop.classList.remove('open');
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

  // ── Profile avatar popover ──
  const avatar     = document.getElementById('user-avatar');
  const profilePop = document.getElementById('profile-popover');
  const toggleProfile = e => {
    e.stopPropagation();
    usagePop.classList.remove('open');
    const open = profilePop.classList.toggle('open');
    if (open) renderProfile();
  };
  avatar.addEventListener('click', toggleProfile);
  avatar.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProfile(e); }
  });
  document.addEventListener('click', e => {
    if (profilePop.classList.contains('open') &&
        !profilePop.contains(e.target) && !avatar.contains(e.target)) {
      profilePop.classList.remove('open');
    }
  });
  document.getElementById('github-user').addEventListener('change', () => {
    saveSettingsFromUI();
    loadGithubProfile(true);
  });
  loadGithubProfile();

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      closeSettings(); closeConfirm(); closeMobileSidebar();
      usagePop.classList.remove('open');
      profilePop.classList.remove('open');
    }
    if (mod && e.key === 'n') { e.preventDefault(); newChat(); }
    if (mod && e.key === 'k') { e.preventDefault(); document.getElementById('search-input').focus(); }
  });

  // Refresh relative times + usage countdown every 60 s
  setInterval(() => { renderSidebar(); if (usagePop.classList.contains('open')) renderUsage(); }, 60000);
}

document.addEventListener('DOMContentLoaded', init);
