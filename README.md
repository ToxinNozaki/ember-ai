# Ember AI

A free, cloud-hosted AI chat app powered by the **DeepSeek API** with a Claude-inspired UI. No server costs, no local hardware — runs entirely on GitHub Pages + Cloudflare Workers free tiers.

---

## Architecture

| Layer | What it is | Cost |
|---|---|---|
| **Frontend** | Static HTML/CSS/JS on GitHub Pages | Free |
| **API Proxy** | Cloudflare Worker (hides your API key) | Free — 100k req/day |
| **AI Model** | DeepSeek V3 via `deepseek-chat` | Free — 5M tokens on signup |

---

## Setup (15 minutes total)

### Step 1 — Get a DeepSeek API key

1. Go to [platform.deepseek.com](https://platform.deepseek.com) and sign up.
2. Navigate to **API Keys** → **Create new key**.
3. Copy it — you won't see it again.

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
wrangler secret put DEEPSEEK_API_KEY
# Paste your DeepSeek key when prompted — it is encrypted and never visible again
```

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
2. Click the **gear icon** (bottom-left) to open Settings.
3. Paste your **Cloudflare Worker URL** into the field.
4. Click **Test Connection** — you should see "✓ Connected successfully!"
5. Start chatting.

---

## Features

- **Streaming responses** — text appears token-by-token, just like Claude
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

| Model | Description |
|---|---|
| `deepseek-chat` | DeepSeek V3 — fast, high quality, best for most tasks |
| `deepseek-reasoner` | DeepSeek R1 — extended chain-of-thought reasoning, slower |

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

All conversation history is stored **only in your browser's localStorage** — nothing is sent to any server except the messages you explicitly send to the AI. Your DeepSeek API key is stored **only inside Cloudflare's encrypted secrets** and is never visible after you set it.
