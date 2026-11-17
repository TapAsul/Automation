import {
  mimeTypeForFilename,
  type StorageBackend,
} from "../server/storageAdapter.js";

/**
 * Native Cloudflare R2 implementation of `StorageBackend`.
 *
 * Works directly on the Cloudflare Workers Free plan via an `r2_buckets`
 * binding in `wrangler.jsonc` — no Docker container, no FUSE mount, and no
 * AWS/S3 access keys required.
 *
 * Uses the exact same object keys that the previous TigrisFS mount stored in
 * `klipcart-studio-data` (`model-config.json`, `usage.json`, `jobs/*`,
 * `projects/<id>/project.json`, `projects/<id>/assets/*`), preserving all
 * existing bucket data automatically.
 */
export function createR2Storage(bucket: R2Bucket): StorageBackend {
  return {
    kind: "r2",

    async getText(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return await obj.text();
    },

    async putText(key, value, contentType = "application/json; charset=utf-8") {
      await bucket.put(key, value, {
        httpMetadata: { contentType },
      });
    },

    async getBinary(key, range) {
      if (range) {
        const r2Range: R2Range =
          range.length !== undefined
            ? { offset: range.offset, length: range.length }
            : { offset: range.offset };
        const obj = await bucket.get(key, { range: r2Range });
        if (!obj) return null;

        const totalSize = obj.size;
        const resolved =
          obj.range && "offset" in obj.range
            ? {
                offset: obj.range.offset ?? range.offset,
                length:
                  obj.range.length ?? Math.max(0, totalSize - range.offset),
              }
            : {
                offset: range.offset,
                length:
                  range.length !== undefined
                    ? Math.min(range.length, Math.max(0, totalSize - range.offset))
                    : Math.max(0, totalSize - range.offset),
              };

        if (totalSize > 0 && resolved.offset < totalSize && resolved.length > 0) {
          const start = resolved.offset;
          const end = Math.min(totalSize - 1, start + resolved.length - 1);
          return {
            body: obj.body as unknown as ReadableStream<Uint8Array>,
            contentType:
              obj.httpMetadata?.contentType || mimeTypeForFilename(key),
            totalSize,
            contentLength: end - start + 1,
            etag: obj.httpEtag,
            range: { start, end },
          };
        }

        return {
          body: obj.body as unknown as ReadableStream<Uint8Array>,
          contentType:
            obj.httpMetadata?.contentType || mimeTypeForFilename(key),
          totalSize,
          contentLength: totalSize,
          etag: obj.httpEtag,
        };
      }

      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        body: obj.body as unknown as ReadableStream<Uint8Array>,
        contentType: obj.httpMetadata?.contentType || mimeTypeForFilename(key),
        totalSize: obj.size,
        contentLength: obj.size,
        etag: obj.httpEtag,
      };
    },

    async putBinary(key, data, contentType, knownLength) {
      const resolvedType = contentType || mimeTypeForFilename(key);
      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        await bucket.put(key, data, {
          httpMetadata: { contentType: resolvedType },
        });
        return;
      }

      if (
        typeof knownLength === "number" &&
        Number.isSafeInteger(knownLength) &&
        knownLength === 0
      ) {
        await bucket.put(key, new Uint8Array(0), {
          httpMetadata: { contentType: resolvedType },
        });
        return;
      }

      // R2 requires ReadableStreams to have a known byte length. When the
      // incoming HTTP request has a Content-Length header, pipe through a
      // FixedLengthStream for zero-copy streaming; otherwise buffer safely.
      if (
        typeof knownLength === "number" &&
        Number.isSafeInteger(knownLength) &&
        knownLength > 0 &&
        typeof FixedLengthStream !== "undefined"
      ) {
        const fixed = new FixedLengthStream(knownLength);
        const pump = data.pipeTo(
          fixed.writable as unknown as WritableStream<Uint8Array>
        );
        await Promise.all([
          bucket.put(key, fixed.readable, {
            httpMetadata: { contentType: resolvedType },
          }),
          pump,
        ]);
        return;
      }

      const buffered = await new Response(data).arrayBuffer();
      if (buffered.byteLength > 65 * 1024 * 1024) {
        throw new Error("Asset exceeds maximum allowed size (65 MB).");
      }
      await bucket.put(key, buffered, {
        httpMetadata: { contentType: resolvedType },
      });
    },

    async copy(sourceKey, targetKey, fallbackContentType) {
      const source = await bucket.get(sourceKey);
      if (!source) return false;
      const contentType =
        source.httpMetadata?.contentType ||
        fallbackContentType ||
        mimeTypeForFilename(targetKey);
      await bucket.put(targetKey, source.body, {
        httpMetadata: { contentType },
      });
      return true;
    },

    async delete(key) {
      await bucket.delete(key);
    },

    async deletePrefix(prefix) {
      const keys = await this.listKeys(prefix);
      if (keys.length === 0) return false;
      // R2 allows deleting up to 1,000 keys per batch call.
      for (let i = 0; i < keys.length; i += 1000) {
        await bucket.delete(keys.slice(i, i + 1000));
      }
      return true;
    },

    async listKeys(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const listed = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const obj of listed.objects) {
          keys.push(obj.key);
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return keys;
    },
  };
}
