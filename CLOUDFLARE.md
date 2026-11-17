# Deploy KlipCart on Cloudflare Workers Free

KlipCart deploys natively on **Cloudflare Workers Free** using:

- **Cloudflare Workers Static Assets** — serves the built React/Vite UI from `./dist` for free on Cloudflare's global CDN (no cold starts).
- **Cloudflare Worker (`cloudflare/worker.ts`)** — handles every `/api/*` endpoint on the same origin using Web Standard `fetch` and `@google/genai/web`.
- **Cloudflare R2 (`klipcart-studio-data`)** — stores saved projects, uploaded/generated images and videos, usage telemetry, and model settings using a direct native Worker binding (`env.STUDIO_DATA`).

**No Docker Desktop, no Cloudflare Containers, no Durable Objects, no Workers Paid subscription, and no `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets are required.**

## Requirements

- A **Cloudflare Workers Free** account.
- **R2** enabled on your Cloudflare account (R2 Free Tier includes 10 GB storage, 1M Class A writes, and 10M Class B reads per month at $0).
- **Node.js 22.12+** (Node 24 works) and **npm**.
- A **Google Gemini API key** (`GEMINI_API_KEY`) for AI analysis, copywriting, voiceover, and image/video studio features.

## Windows PowerShell Deployment Steps

### 1. Open the project folder and install packages

```powershell
cd C:\Users\PC\OneDrive\Documents\Automation\Automation
npm install
```

### 2. Verify your Cloudflare login

```powershell
npx.cmd wrangler whoami
```

If you are not logged in yet, run:

```powershell
npx.cmd wrangler login
```

### 3. Ensure your R2 bucket exists

If you already created `klipcart-studio-data`, check it with:

```powershell
npx.cmd wrangler r2 bucket list
```

If it does not appear in the list yet, create it once:

```powershell
npx.cmd wrangler r2 bucket create klipcart-studio-data
```

### 4. Set your Gemini API key secret

```powershell
npx.cmd wrangler secret put GEMINI_API_KEY
```

When prompted, paste your Gemini API key and press **Enter**. (If you already saved `GEMINI_API_KEY` on the `klipcart` Worker earlier, Cloudflare keeps it automatically — you only need to re-run this if you want to update it.)

> Optional cleanup: If you previously added `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` for the old container setup, they are no longer needed and can be safely removed:
>
> ```powershell
> npx.cmd wrangler secret delete AWS_ACCESS_KEY_ID
> npx.cmd wrangler secret delete AWS_SECRET_ACCESS_KEY
> ```

### 5. Deploy KlipCart

```powershell
npx.cmd wrangler deploy
```

Wrangler automatically runs `npm run build`, uploads the React UI to Workers Static Assets, binds R2 (`klipcart-studio-data`), removes the old unused `KlipCartContainer` Durable Object class via migration `v2`, and prints your live URL:

```text
https://klipcart.<your-subdomain>.workers.dev
```

### 6. (Optional) Sync existing local `.studio-data` files to R2

Any data already inside `klipcart-studio-data` works immediately because all R2 object keys (`model-config.json`, `usage.json`, `projects/<id>/project.json`, `projects/<id>/assets/*`, `jobs/*`) were preserved unchanged.

If you also want to copy projects/settings from your local `.studio-data` folder into your live R2 bucket, run:

```powershell
npm run cloudflare:sync-r2
```

## Deploy Without R2 (Optional Zero-Card Mode)

If R2 is not enabled on your Cloudflare account yet, remove or comment out the `"r2_buckets"` block in `wrangler.jsonc` and run `npx.cmd wrangler deploy`. The Worker automatically falls back to temporary in-memory storage so product analysis, background removal, studio compositing, local video rendering, copywriting, and voiceover still work on Cloudflare Free (saved projects simply reset when the Worker restarts until you re-enable `r2_buckets`).

## Local Development

### Option A: Local Node/Express + Vite (fast hot reload, saves to `.studio-data/`)

Copy `.env.example` to `.env`, set `GEMINI_API_KEY`, then run:

```powershell
npm run dev
```

### Option B: Local Cloudflare Workers + R2 simulator

Create a `.dev.vars` file with `GEMINI_API_KEY=your_key_here` (never commit `.dev.vars`), then run:

```powershell
npx.cmd wrangler dev
```
