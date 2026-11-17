# syntax=docker/dockerfile:1
#
# OPTIONAL self-hosted Docker image for running KlipCart on any standard
# Node.js container host (or local Docker).
#
# NOTE: Cloudflare deployment (`npx.cmd wrangler deploy`) does NOT use Docker
# or Cloudflare Containers anymore — it runs natively on Cloudflare Workers
# Free + Static Assets + R2. See CLOUDFLARE.md for details.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && mkdir -p /app/.studio-data

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/app

EXPOSE 3000
CMD ["npm", "start"]
