# syntax=docker/dockerfile:1

ARG TIGRISFS_VERSION=v1.2.1

FROM node:22-alpine
ARG TIGRISFS_VERSION

WORKDIR /app

# FUSE is used to mount the app's .studio-data directory onto Cloudflare R2.
RUN apk add --no-cache bash ca-certificates curl fuse fuse-dev

# Install TigrisFS, which exposes the R2 S3-compatible bucket as a filesystem.
RUN set -eux; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64) ARCH="amd64" ;; \
      aarch64) ARCH="arm64" ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fL "https://github.com/tigrisdata/tigrisfs/releases/download/${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION#v}_linux_${ARCH}.tar.gz" \
      | tar -xzf - -C /usr/local/bin/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

COPY cloudflare/start-container.sh /usr/local/bin/start-container
RUN chmod +x /usr/local/bin/start-container && mkdir -p /app/.studio-data

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/app

EXPOSE 3000
CMD ["/usr/local/bin/start-container"]
