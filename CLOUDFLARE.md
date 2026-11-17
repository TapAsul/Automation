# Deploy the full KlipCart app on Cloudflare

The dashboard's **Upload and deploy** screen is for already-built static files. This project also has a Node/Express API, so uploading the source ZIP there cannot deploy the complete app.

This setup uses **Cloudflare Workers + Containers** to run the existing Node server and serves the React UI and `/api` endpoints from the same app. It stores `.studio-data` on an R2 bucket, so saved projects and generated files survive container restarts.

## Requirements

- A Cloudflare account with **Containers** enabled.
- Node.js 22.12 or newer and npm.
- Docker Desktop or Docker Engine running on the computer used to deploy. Wrangler builds the container image from `Dockerfile`.
- An R2 bucket and an R2 S3 API token with read/write access to that bucket.
- A Gemini API key for AI features.

## One-time setup

1. Extract the project ZIP and open a terminal in the `KlipCart` folder.
2. Install dependencies and sign in to Cloudflare:

   ```sh
   npm install
   npx wrangler login
   ```

3. Create the app's private data bucket:

   ```sh
   npx wrangler r2 bucket create klipcart-studio-data
   ```

   If you already created this bucket, skip this command. In `wrangler.jsonc`, replace `REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID` with the account ID shown in your Cloudflare dashboard. The bucket name should match the one in that file.

4. In Cloudflare, create an R2 API token with **Object Read & Write** access limited to `klipcart-studio-data`. Then add the credentials as Wrangler secrets:

   ```sh
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   npx wrangler secret put GEMINI_API_KEY
   ```

   Wrangler prompts for each value. Keep these values private; do not paste them into source files or chat.

## Deploy

Make sure Docker is running, then from the project folder run:

```sh
npm run cloudflare:deploy
```

Wrangler builds the container and deploys the Worker. It prints the app URL when deployment finishes. The first visit may take a little longer while the container starts.

## Local development

For the existing local Node app, copy `.env.example` to `.env`, add your `GEMINI_API_KEY`, then run:

```sh
npm install
npm run dev
```

Do not use the Cloudflare dashboard's drag-and-drop upload for the source files. Use the `cloudflare:deploy` command above instead.
