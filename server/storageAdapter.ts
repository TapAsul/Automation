/**
 * Runtime-agnostic persistent storage abstraction shared by:
 * - Cloudflare Workers Free (`cloudflare/r2Storage.ts`, native R2 bucket binding)
 * - Local Node.js / Express development (`server/fsStorage.ts`, `.studio-data/` folder)
 * - Optional in-memory fallback (`createMemoryStorage`) if R2 is not bound
 *
 * All object keys map 1-to-1 with paths inside `.studio-data/`:
 * - `model-config.json`
 * - `usage.json`
 * - `jobs/{jobId}.json`
 * - `jobs/{jobId}.mp4`
 * - `projects/{projectId}/project.json`
 * - `projects/{projectId}/assets/{filename}`
 */

export interface ByteRangeRequest {
  offset: number;
  length?: number;
}

export interface StoredBinaryObject {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  totalSize: number;
  contentLength: number;
  etag?: string;
  range?: {
    start: number;
    end: number;
  };
}

export interface StorageBackend {
  readonly kind: "r2" | "filesystem" | "memory";
  getText(key: string): Promise<string | null>;
  putText(key: string, value: string, contentType?: string): Promise<void>;
  getBinary(
    key: string,
    range?: ByteRangeRequest
  ): Promise<StoredBinaryObject | null>;
  putBinary(
    key: string,
    data: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
    contentType: string,
    knownLength?: number
  ): Promise<void>;
  copy(
    sourceKey: string,
    targetKey: string,
    fallbackContentType?: string
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<boolean>;
  listKeys(prefix: string): Promise<string[]>;
}

export function mimeTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

/**
 * Parses a single HTTP `Range: bytes=start-end` header for HTML5 video/audio streaming.
 */
export function parseByteRangeHeader(
  rangeHeader: string | null
): ByteRangeRequest | undefined {
  if (!rangeHeader) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return undefined;
  if (match[2] === "") {
    return { offset: start };
  }
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) return undefined;
  return { offset: start, length: end - start + 1 };
}

/**
 * Builds an HTTP Response for a stored binary asset, supporting 206 Partial Content
 * for browser video/audio scrubbing and optional attachment downloads.
 */
export function buildBinaryResponse(
  obj: StoredBinaryObject,
  options?: {
    downloadFilename?: string;
    fallbackContentType?: string;
  }
): Response {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    obj.contentType || options?.fallbackContentType || "application/octet-stream"
  );
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(obj.contentLength));
  headers.set("Cache-Control", "private, max-age=300");

  if (obj.etag) {
    headers.set("ETag", obj.etag);
  }
  if (options?.downloadFilename) {
    const safeName = options.downloadFilename.replace(/["\\\r\n]/g, "_");
    headers.set("Content-Disposition", `attachment; filename="${safeName}"`);
  }

  if (obj.range) {
    headers.set(
      "Content-Range",
      `bytes ${obj.range.start}-${obj.range.end}/${obj.totalSize}`
    );
    return new Response(obj.body, { status: 206, headers });
  }

  return new Response(obj.body, { status: 200, headers });
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAllBytes(
  data: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  const ab = await new Response(data).arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Ephemeral in-memory fallback so the showcase generator still works even if
 * someone deploys without configuring an R2 bucket binding.
 */
export function createMemoryStorage(): StorageBackend {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    kind: "memory",

    async getText(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return decoder.decode(entry.bytes);
    },

    async putText(key, value, contentType = "application/json; charset=utf-8") {
      store.set(key, { bytes: encoder.encode(value), contentType });
    },

    async getBinary(key, range) {
      const entry = store.get(key);
      if (!entry) return null;
      const totalSize = entry.bytes.byteLength;
      if (range && totalSize > 0 && range.offset < totalSize) {
        const start = range.offset;
        const end =
          range.length !== undefined
            ? Math.min(totalSize - 1, start + range.length - 1)
            : totalSize - 1;
        const slice = entry.bytes.subarray(start, end + 1);
        return {
          body: bytesToStream(slice),
          contentType: entry.contentType || mimeTypeForFilename(key),
          totalSize,
          contentLength: slice.byteLength,
          range: { start, end },
        };
      }
      return {
        body: bytesToStream(entry.bytes),
        contentType: entry.contentType || mimeTypeForFilename(key),
        totalSize,
        contentLength: totalSize,
      };
    },

    async putBinary(key, data, contentType) {
      const bytes = await readAllBytes(data);
      store.set(key, {
        bytes,
        contentType: contentType || mimeTypeForFilename(key),
      });
    },

    async copy(sourceKey, targetKey, fallbackContentType) {
      const entry = store.get(sourceKey);
      if (!entry) return false;
      store.set(targetKey, {
        bytes: entry.bytes.slice(),
        contentType:
          entry.contentType ||
          fallbackContentType ||
          mimeTypeForFilename(targetKey),
      });
      return true;
    },

    async delete(key) {
      store.delete(key);
    },

    async deletePrefix(prefix) {
      let deletedAny = false;
      for (const key of Array.from(store.keys())) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          deletedAny = true;
        }
      }
      return deletedAny;
    },

    async listKeys(prefix) {
      const matches: string[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          matches.push(key);
        }
      }
      return matches.sort();
    },
  };
}
