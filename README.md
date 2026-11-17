# KlipCart

A React/Vite storefront-ad creative studio with a Node/Express API.

## Run locally

```sh
npm install
npm run dev
```

Set `GEMINI_API_KEY` in a local `.env` file to enable Gemini-powered features. See `.env.example` for the variable name.

## Deploy to Cloudflare

This app needs its Express backend, so do not use the dashboard's static drag-and-drop uploader. Follow [`CLOUDFLARE.md`](./CLOUDFLARE.md) to deploy it with Cloudflare Workers Containers and R2.
