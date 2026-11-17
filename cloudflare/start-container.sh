#!/bin/sh
set -eu

: "${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID in wrangler.jsonc}"
: "${R2_BUCKET_NAME:?Set R2_BUCKET_NAME in wrangler.jsonc}"
: "${AWS_ACCESS_KEY_ID:?Set the R2 access key with wrangler secret put AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set the R2 secret key with wrangler secret put AWS_SECRET_ACCESS_KEY}"

DATA_DIR="/app/.studio-data"
mkdir -p "$DATA_DIR"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Keep project JSON, generated assets, videos, and model settings in R2 so they
# survive when Cloudflare stops and later restarts the container.
echo "Mounting R2 bucket '${R2_BUCKET_NAME}' at ${DATA_DIR}..."
/usr/local/bin/tigrisfs --endpoint "$R2_ENDPOINT" -f "$R2_BUCKET_NAME" "$DATA_DIR" &
FUSE_PID=$!
sleep 3
if ! kill -0 "$FUSE_PID" 2>/dev/null; then
  echo "R2 filesystem mount did not start." >&2
  exit 1
fi

exec npm start
