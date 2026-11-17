# KlipCart

A React/Vite product showcase generator and TikTok Shop creative studio backed by Google Gemini AI and persistent project storage.

## Run locally

```powershell
npm install
npm run dev
```

Copy `.env.example` to `.env` and set your `GEMINI_API_KEY` to enable Gemini-powered features. Local projects and assets are saved in `.studio-data/`.

## Deploy to Cloudflare (Free Plan)

KlipCart runs natively on **Cloudflare Workers Free** with Workers Static Assets and a direct Cloudflare R2 bucket binding (`klipcart-studio-data`) — no Docker or Cloudflare Containers required:

```powershell
npx.cmd wrangler deploy
```

Follow [`CLOUDFLARE.md`](./CLOUDFLARE.md) for complete step-by-step Windows PowerShell setup and deployment instructions.
