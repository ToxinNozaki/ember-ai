/**
 * Ember AI — Cloudflare Worker Proxy
 *
 * Provider: Google Gemini (free tier — no credit card, ~1,500 requests/day).
 * Uses Gemini's OpenAI-compatible endpoint, so the frontend needs no changes.
 *
 * Get a free key at: https://aistudio.google.com/apikey
 *
 * Deploy steps:
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler secret put GEMINI_API_KEY     ← paste your Google AI Studio key (stored encrypted)
 *   wrangler deploy
 *
 * Update ALLOWED_ORIGIN below to match your GitHub Pages URL before deploying.
 *
 * ── Want a different free provider? Just change UPSTREAM_API + the env key name: ──
 *   Groq    : https://api.groq.com/openai/v1/chat/completions          (models: llama-3.3-70b-versatile)
 *   OpenRouter: https://openrouter.ai/api/v1/chat/completions          (models: *:free variants)
 *   Cerebras: https://api.cerebras.ai/v1/chat/completions              (models: llama-3.3-70b)
 *   DeepSeek: https://api.deepseek.com/v1/chat/completions             (paid)
 */

const ALLOWED_ORIGIN = 'https://toxinnozaki.github.io'; // GitHub Pages origin (scheme+host only, no path)
const UPSTREAM_API   = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';

    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── Method guard ──
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ── Origin guard ──
    if (!isAllowed(origin)) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── Parse body ──
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }

    // ── Forward to upstream provider ──
    let upstream;
    try {
      upstream = await fetch(UPSTREAM_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GEMINI_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Upstream fetch failed: ${err.message}` }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } },
      );
    }

    // ── Stream or JSON response ──
    if (body.stream) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type':      'text/event-stream',
          'Cache-Control':     'no-cache',
          'X-Accel-Buffering': 'no',
          ...corsHeaders(origin),
        },
      });
    }

    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        ...corsHeaders(origin),
      },
    });
  },
};

function isAllowed(origin) {
  if (!origin) return true;                                         // direct / curl
  if (origin === ALLOWED_ORIGIN) return true;                       // production
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true; // local dev
  return false;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}
