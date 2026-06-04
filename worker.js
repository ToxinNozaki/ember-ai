/**
 * Ember AI — Cloudflare Worker Proxy (multi-provider)
 *
 * Routes each request to a free LLM provider based on a "provider:model" prefix
 * sent by the frontend. Every provider below has a free tier with no credit card.
 * Add only the keys you want — models whose key is missing return a clear error.
 *
 * Free keys (no credit card):
 *   Gemini      → https://aistudio.google.com/apikey        secret: GEMINI_API_KEY
 *   Groq        → https://console.groq.com/keys             secret: GROQ_API_KEY
 *   OpenRouter  → https://openrouter.ai/keys                secret: OPENROUTER_API_KEY
 *   GitHub      → https://github.com/settings/tokens (PAT, "models:read")  secret: GITHUB_MODELS_TOKEN
 *
 * Deploy:
 *   wrangler secret put GEMINI_API_KEY        (repeat for each provider you use)
 *   wrangler deploy
 *
 * Update ALLOWED_ORIGIN to your GitHub Pages URL before deploying.
 */

const ALLOWED_ORIGIN   = 'https://toxinnozaki.github.io'; // scheme+host only, no path
const DEFAULT_PROVIDER = 'gemini';

const PROVIDERS = {
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: 'GEMINI_API_KEY'      },
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',                            key: 'GROQ_API_KEY'        },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',                              key: 'OPENROUTER_API_KEY'  },
  github:     { url: 'https://models.github.ai/inference/chat/completions',                        key: 'GITHUB_MODELS_TOKEN' },
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!isAllowed(origin)) {
      return new Response('Forbidden', { status: 403 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }

    // ── Passphrase gate (only enforced when the EMBER_PASSPHRASE secret is set) ──
    if (env.EMBER_PASSPHRASE) {
      const given = request.headers.get('X-Ember-Passphrase') || '';
      if (given !== env.EMBER_PASSPHRASE) {
        return json({ error: { message: 'Invalid or missing passphrase.' } }, 401, origin);
      }
    }

    // ── Lightweight auth/health check — validates passphrase without a model call ──
    if (body.ping) {
      return json({ ok: true }, 200, origin);
    }

    // ── Rate limiting (only active when the RL KV namespace is bound) ──
    const limited = await checkRateLimit(env, request, origin);
    if (limited) return limited;

    // ── Image generation via Cloudflare Workers AI (FLUX.1-schnell, free) ──
    if (body.generate_image) {
      if (!env.AI) {
        return json({ error: { message: 'Image generation is not enabled. Add the [ai] binding to wrangler.toml and redeploy.' } }, 400, origin);
      }
      try {
        const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
          prompt: String(body.prompt || '').slice(0, 2000),
          steps:  6,
        });
        // FLUX returns { image: "<base64 jpeg>" }
        return json({ image: out.image }, 200, origin);
      } catch (e) {
        return json({ error: { message: `Image generation failed: ${e.message}` } }, 502, origin);
      }
    }

    // ── Resolve provider from "provider:model" prefix ──
    const rawModel = String(body.model || '');
    const sep      = rawModel.indexOf(':');
    let providerName = DEFAULT_PROVIDER;
    let modelId      = rawModel;
    if (sep > 0 && PROVIDERS[rawModel.slice(0, sep)]) {
      providerName = rawModel.slice(0, sep);
      modelId      = rawModel.slice(sep + 1);
    }

    const provider = PROVIDERS[providerName];
    const apiKey   = env[provider.key];
    if (!apiKey) {
      return json(
        { error: { message: `Provider "${providerName}" has no key configured. In your terminal run:  wrangler secret put ${provider.key}` } },
        400, origin,
      );
    }

    body.model = modelId; // strip the provider prefix before forwarding

    // ── Guard rails: clamp max_tokens + cap request size ──
    if (typeof body.max_tokens === 'number') body.max_tokens = Math.min(Math.max(body.max_tokens, 1), 4096);
    if (JSON.stringify(body.messages || '').length > 200000) {
      return json({ error: { message: 'Request too large.' } }, 413, origin);
    }

    // ── Forward to provider ──
    let upstream;
    try {
      upstream = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return json({ error: { message: `Upstream fetch failed: ${err.message}` } }, 502, origin);
    }

    // ── Stream or JSON passthrough ──
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

// Per-IP daily rate limit. No-op unless the RL KV namespace is bound.
async function checkRateLimit(env, request, origin) {
  if (!env.RL) return null;
  const LIMIT = 300;
  const ip  = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${ip}:${day}`;
  const cur = parseInt((await env.RL.get(key)) || '0', 10);
  if (cur >= LIMIT) {
    return json({ error: { message: 'Daily request limit reached for your connection. Try again tomorrow.' } }, 429, origin);
  }
  await env.RL.put(key, String(cur + 1), { expirationTtl: 90000 }); // ~25h
  return null;
}

function isAllowed(origin) {
  // The Worker URL is public (shared with friends), so require a matching
  // browser Origin to reduce abuse of the shared API quota. Browsers always
  // send Origin on cross-origin POSTs; missing/foreign origins are rejected.
  if (origin === ALLOWED_ORIGIN) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ember-Passphrase',
    'Access-Control-Max-Age':       '86400',
    // Basic security headers on every response
    'X-Content-Type-Options':       'nosniff',
    'X-Frame-Options':              'DENY',
    'Referrer-Policy':              'strict-origin-when-cross-origin',
  };
}
