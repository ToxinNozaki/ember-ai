# Ember AI

A **100% free**, cloud-hosted AI chat app powered by **Google Gemini** with a Claude-inspired UI. No server costs, no local hardware, **no credit card** — runs entirely on GitHub Pages + Cloudflare Workers + Google AI Studio free tiers.

---

## Architecture

| Layer | What it is | Cost |
|---|---|---|
| **Frontend** | Static HTML/CSS/JS on GitHub Pages | Free |
| **API Proxy** | Cloudflare Worker (hides your API key) | Free — 100k req/day |
| **AI Model** | Google Gemini 2.5 Flash | Free — ~1,500 requests/day, no credit card |

> Gemini uses an **OpenAI-compatible** endpoint, so the frontend code is provider-agnostic. To switch providers (Groq, OpenRouter, Cerebras, DeepSeek…), change `UPSTREAM_API` and the env key name in `worker.js` — see the comments at the top of that file.

---

## Setup (15 minutes total)

### Step 1 — Get a free Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key** (no credit card required).
3. Copy it.

---

### Step 2 — Deploy the Cloudflare Worker

This proxy holds your API key securely so it never appears in frontend code or Git.

```bash
# Install Wrangler (Cloudflare's CLI)
npm install -g wrangler

# Authenticate
wrangler login

# Clone / enter this repo
cd ember-ai

# Deploy the worker
wrangler deploy
```

After deploying, Wrangler prints your Worker URL:
```
https://ember-ai-proxy.YOUR-SUBDOMAIN.workers.dev
```
**Save this URL** — you'll paste it into the app's Settings later.

Now store your API key as an encrypted secret:
```bash
wrangler secret put GEMINI_API_KEY
# Paste your Gemini key when prompted — it is encrypted and never visible again
```

#### (Optional) Add more free providers

The app can switch between providers from the model dropdown — handy when one provider's daily quota runs out, since **each provider has its own independent free quota**. Add only the ones you want:

```bash
# Groq — free, ultra-fast Llama        https://console.groq.com/keys
wrangler secret put GROQ_API_KEY

# GitHub Models — free GPT-4o, etc.    https://github.com/settings/tokens  (scope: models:read)
wrangler secret put GITHUB_MODELS_TOKEN

# OpenRouter — free community models   https://openrouter.ai/keys
wrangler secret put OPENROUTER_API_KEY
```

Any model whose provider key you haven't set will simply return a clear "no key configured" message — the others keep working.

Finally, open `worker.js` and update the `ALLOWED_ORIGIN` constant to your GitHub Pages URL (see Step 4 for that URL), then re-deploy:
```bash
wrangler deploy
```

---

### Step 3 — Fork / push to GitHub

1. [Fork this repo](https://github.com) or create a new repo and push these files to the `main` branch.
2. Your repo URL will be `https://github.com/YOUR_USERNAME/YOUR_REPO`.

---

### Step 4 — Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**.
2. Under **Source**, select **GitHub Actions**.
3. Push any commit to `main` — the workflow in `.github/workflows/deploy.yml` will run automatically.
4. After ~30 seconds, Pages will be live at:
   ```
   https://YOUR_USERNAME.github.io/YOUR_REPO/
   ```

Copy this URL and paste it into `ALLOWED_ORIGIN` in `worker.js`, then re-run `wrangler deploy`.

---

### Step 5 — Configure the app

1. Open your site: `https://YOUR_USERNAME.github.io/YOUR_REPO/`
2. The **Worker URL is pre-filled** with the one baked into `app.js` (`DEFAULT_WORKER_URL`). If you deployed your own Worker, open it in **Settings → Cloudflare Worker URL** and replace it, then update `DEFAULT_WORKER_URL` in `app.js` so it ships to everyone by default.
3. Click **Test Connection** — you should see "✓ Connected successfully!"
4. Start chatting.

---

## Sharing with friends

Once `DEFAULT_WORKER_URL` in `app.js` points to your deployed Worker, **anyone who opens your GitHub Pages link can chat immediately** — no setup, no key entry. The Worker holds your keys server-side and only accepts requests from your Pages origin (`ALLOWED_ORIGIN`), so the keys are never exposed.

A few things to know:

- **Shared quota.** All friends draw on *your* providers' free daily limits. The model dropdown lets anyone switch providers (Gemini → Groq → GitHub Models → OpenRouter) when one runs out — each has its own quota, so adding all four roughly quadruples daily capacity.
- **Abuse protection.** The Worker rejects requests whose browser `Origin` isn't your Pages site. This isn't bulletproof (Origin can be spoofed by non-browser clients), so don't post the Worker URL publicly. For a tighter setup you can add a shared passphrase check in `worker.js`.
- **History is per-browser.** Each person's conversations live in their own `localStorage` — nobody sees anyone else's chats.

---

## Images (vision)

Click the **paperclip** in the input bar to attach images (up to 6 per message). They're **downscaled in-browser** to ~1280px before sending — faster responses and smaller storage. Vision works only on multimodal models: **Gemini** (default) and **GPT-4o** via GitHub Models. If you attach an image while a text-only model (Llama, etc.) is selected, the app tells you to switch.

> **Video is not supported.** The free OpenAI-compatible chat endpoints don't accept video input — that needs a separate (non-OpenAI-compatible) Gemini Files API integration, which is outside this app's zero-build, single-proxy design.

## A note on "uncensored" mode

This app does **not** include a switch to disable safety filtering or generate NSFW content, for two practical reasons:

1. **It wouldn't work.** Content moderation runs on the **providers' servers** (Google, OpenAI/GitHub, Groq), not in this app — a frontend toggle can't turn it off.
2. **It would get the keys banned.** Every provider's free tier prohibits such content; using the shared keys for it would trigger account bans and **break the app for everyone using it**.

The system prompt is fully editable in **Settings** if you want to adjust tone/personality within the providers' allowed use.

---

## Features

- **Streaming responses** — text appears token-by-token, just like Claude
- **Image attachments** — paperclip to send images to vision models (Gemini / GPT-4o), auto-downscaled
- **Multi-provider** — switch between Gemini, Groq, GitHub Models (GPT-4o), and OpenRouter free models
- **Daily usage meter** — sidebar activity icon shows per-provider request counts vs free limits
- **Zero-config sharing** — Worker URL baked in so friends just open the link
- **Full markdown rendering** — bold, italics, tables, code blocks with syntax highlighting & copy button
- **Conversation history** — stored in `localStorage`, grouped by date, searchable
- **Editable titles** — click the conversation title to rename it inline
- **Dark / light mode** — toggle in sidebar or Settings
- **Settings panel** — model selection, temperature, max tokens, custom system prompt
- **Stop generation** — abort mid-stream
- **Export** — download all conversations as JSON
- **Mobile responsive** — sidebar slides in as overlay on small screens
- **Keyboard shortcuts** — `Ctrl/Cmd+N` new chat, `Ctrl/Cmd+K` search, `Esc` close panels

## Models

All models are **free, no credit card**. Switch anytime from the Settings model dropdown.

| Provider | Models | Notes |
|---|---|---|
| **Google Gemini** | `gemini-2.5-flash`, `-flash-lite`, `-2.0-flash-exp` | Best all-around free tier (~1,500/day). Recommended. |
| **Groq** | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` | Fastest inference on the planet |
| **GitHub Models** | `gpt-4o`, `gpt-4o-mini`, `DeepSeek-R1` | Free **GPT-4o** using a GitHub token (see below) |
| **OpenRouter** | `llama-3.3-70b-instruct:free`, `deepseek-r1:free` | Rotating free community models |

### About GitHub Copilot

GitHub **Copilot has no public, general-purpose chat API** you can call from your own app — its endpoints are gated to the Copilot editor product, and the "extract the Copilot token" hacks **violate GitHub's Terms of Service**, so this app does not use them.

The sanctioned free equivalent is **GitHub Models**, included above: it gives you **GPT-4o, Llama, DeepSeek-R1 and more for free** using a normal GitHub Personal Access Token with the `models:read` scope. That's the legitimate way to get OpenAI-class models through your GitHub account.

### Daily usage meter

Click the **activity icon** in the sidebar to see today's request count per provider with progress bars (resets at midnight). Since free tiers don't expose a live quota API, these counts are tracked **locally in your browser** from the requests this app makes — an accurate estimate of *your* usage against each provider's free daily limit.

## File structure

```
ember-ai/
├── index.html               ← Full app UI
├── style.css                ← All styles (dark + light theme)
├── app.js                   ← All JavaScript (state, streaming, markdown)
├── worker.js                ← Cloudflare Worker proxy (separate deploy)
├── wrangler.toml            ← Cloudflare Worker config
├── .github/
│   └── workflows/
│       └── deploy.yml       ← Auto-deploy to GitHub Pages on push
└── README.md
```

## Local development

Open `index.html` directly in a browser (file://) or serve with any static server:

```bash
npx serve .
# or
python -m http.server 8080
```

The Cloudflare Worker already allows `localhost` and `127.0.0.1` origins, so local testing works out of the box once you have the Worker deployed.

## Privacy

All conversation history is stored **only in your browser's localStorage** — nothing is sent to any server except the messages you explicitly send to the AI. Your Gemini API key is stored **only inside Cloudflare's encrypted secrets** and is never visible after you set it.
