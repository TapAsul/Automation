import { handleApiRequest } from "../server/apiHandler.js";
import {
  createMemoryStorage,
  type StorageBackend,
} from "../server/storageAdapter.js";
import { createR2Storage } from "./r2Storage.js";

export interface Env {
  /** Built React SPA static files from `./dist` (Cloudflare Workers Static Assets). */
  ASSETS: Fetcher;
  /** Native R2 bucket binding (`klipcart-studio-data`) for saved projects, assets, jobs, usage, and model config. */
  STUDIO_DATA?: R2Bucket;
  /** Server-side Google Gemini API key configured with `wrangler secret put GEMINI_API_KEY`. */
  GEMINI_API_KEY?: string;
  /** Optional model identifier overrides. */
  GEMINI_ANALYSIS_MODEL?: string;
  GEMINI_ANALYSIS_FALLBACK_MODEL?: string;
  GEMINI_IMAGE_MODEL?: string;
  GEMINI_VIDEO_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_TTS_FALLBACK_MODEL?: string;
}

// Reuse storage wrapper instances across requests inside the same Worker isolate.
const r2Cache = new WeakMap<R2Bucket, StorageBackend>();
const fallbackMemoryStorage = createMemoryStorage();

function resolveStorage(env: Env): StorageBackend {
  if (!env.STUDIO_DATA) {
    return fallbackMemoryStorage;
  }
  let cached = r2Cache.get(env.STUDIO_DATA);
  if (!cached) {
    cached = createR2Storage(env.STUDIO_DATA);
    r2Cache.set(env.STUDIO_DATA, cached);
  }
  return cached;
}

/**
 * KlipCart — Cloudflare Workers Free entry point.
 *
 * Runs the entire KlipCart `/api/*` backend natively on Cloudflare Workers Free
 * with direct R2 storage (`env.STUDIO_DATA`) and Workers Static Assets
 * (`env.ASSETS`) on the same origin. Requires no Docker containers, no Durable
 * Objects, no S3 access keys, and no Workers Paid subscription.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await handleApiRequest(request, {
      storage: resolveStorage(env),
      geminiApiKey: env.GEMINI_API_KEY,
      modelEnv: {
        GEMINI_ANALYSIS_MODEL: env.GEMINI_ANALYSIS_MODEL,
        GEMINI_ANALYSIS_FALLBACK_MODEL: env.GEMINI_ANALYSIS_FALLBACK_MODEL,
        GEMINI_IMAGE_MODEL: env.GEMINI_IMAGE_MODEL,
        GEMINI_VIDEO_MODEL: env.GEMINI_VIDEO_MODEL,
        GEMINI_TTS_MODEL: env.GEMINI_TTS_MODEL,
        GEMINI_TTS_FALLBACK_MODEL: env.GEMINI_TTS_FALLBACK_MODEL,
      },
      runtime: "cloudflare-workers",
    });

    if (apiResponse) {
      return apiResponse;
    }

    return env.ASSETS.fetch(request);
  },
};
