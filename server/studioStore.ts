import { Buffer } from "node:buffer";
import type {
  ByteRangeRequest,
  StorageBackend,
  StoredBinaryObject,
} from "./storageAdapter.js";
import {
  ALLOWED_ASSET_MIMES,
  MAX_ASSET_BYTES,
  sanitizeFilename,
  sanitizeId,
} from "./validation.js";

const USAGE_KEY = "usage.json";

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type UsageOperationType =
  | "analysis"
  | "copy"
  | "image_gen"
  | "video_gen"
  | "tts";

export interface UsageLogEntry {
  id: string;
  operation: UsageOperationType;
  model: string;
  status: "success" | "error";
  durationMs: number;
  note?: string;
  timestamp: string;
}

export interface UsageStats {
  analysisCalls: number;
  copyCalls: number;
  imageGenCalls: number;
  videoGenCalls: number;
  ttsCalls: number;
  errors: number;
  lastUpdated: string;
  recentLogs: UsageLogEntry[];
}

function defaultUsage(): UsageStats {
  return {
    analysisCalls: 0,
    copyCalls: 0,
    imageGenCalls: 0,
    videoGenCalls: 0,
    ttsCalls: 0,
    errors: 0,
    lastUpdated: new Date().toISOString(),
    recentLogs: [],
  };
}

export async function getUsageStats(
  storage: StorageBackend
): Promise<UsageStats> {
  const raw = await storage.getText(USAGE_KEY);
  if (!raw) {
    const fresh = defaultUsage();
    await storage.putText(USAGE_KEY, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UsageStats>;
    return {
      analysisCalls: parsed.analysisCalls ?? 0,
      copyCalls: parsed.copyCalls ?? 0,
      imageGenCalls: parsed.imageGenCalls ?? 0,
      videoGenCalls: parsed.videoGenCalls ?? 0,
      ttsCalls: parsed.ttsCalls ?? 0,
      errors: parsed.errors ?? 0,
      lastUpdated: parsed.lastUpdated || new Date().toISOString(),
      recentLogs: Array.isArray(parsed.recentLogs) ? parsed.recentLogs : [],
    };
  } catch {
    return defaultUsage();
  }
}

export async function recordUsage(
  storage: StorageBackend,
  operation: UsageOperationType,
  model: string,
  status: "success" | "error",
  durationMs: number,
  note?: string
): Promise<void> {
  try {
    const stats = await getUsageStats(storage);
    if (status === "success") {
      if (operation === "analysis") stats.analysisCalls++;
      else if (operation === "copy") stats.copyCalls++;
      else if (operation === "image_gen") stats.imageGenCalls++;
      else if (operation === "video_gen") stats.videoGenCalls++;
      else if (operation === "tts") stats.ttsCalls++;
    } else {
      stats.errors++;
    }
    stats.lastUpdated = new Date().toISOString();
    stats.recentLogs.unshift({
      id: crypto.randomUUID().slice(0, 8),
      operation,
      model,
      status,
      durationMs: Math.round(durationMs),
      note: note?.slice(0, 140),
      timestamp: stats.lastUpdated,
    });
    stats.recentLogs = stats.recentLogs.slice(0, 30);
    await storage.putText(USAGE_KEY, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.warn("Usage telemetry write failed:", err);
  }
}

export interface GenerationJob {
  id: string;
  type: "image" | "video" | "analysis";
  status: "queued" | "processing" | "completed" | "failed";
  model: string;
  interactionId?: string;
  aspectRatio?: string;
  durationSec?: number;
  resolution?: string;
  videoFile?: string;
  videoUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

async function persistJob(
  storage: StorageBackend,
  job: GenerationJob
): Promise<void> {
  await storage.putText(
    `jobs/${job.id}.json`,
    JSON.stringify(job, null, 2)
  );
}

export async function createJob(
  storage: StorageBackend,
  job: Omit<GenerationJob, "id" | "createdAt" | "updatedAt">
): Promise<GenerationJob> {
  const id = `job_${randomHex(6)}`;
  const now = new Date().toISOString();
  const full: GenerationJob = {
    ...job,
    id,
    createdAt: now,
    updatedAt: now,
  };
  await persistJob(storage, full);
  return full;
}

export async function getJob(
  storage: StorageBackend,
  id: string
): Promise<GenerationJob | null> {
  const safe = sanitizeId(id);
  if (!safe) return null;
  const raw = await storage.getText(`jobs/${safe}.json`);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as GenerationJob;
    if (stored.id !== safe) return null;
    return stored;
  } catch {
    return null;
  }
}

export async function updateJob(
  storage: StorageBackend,
  id: string,
  patch: Partial<Omit<GenerationJob, "id" | "createdAt">>
): Promise<GenerationJob | null> {
  const safe = sanitizeId(id);
  if (!safe) return null;
  const existing = await getJob(storage, safe);
  if (!existing) return null;
  const updated: GenerationJob = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await persistJob(storage, updated);
  return updated;
}

export async function saveJobVideoBytes(
  storage: StorageBackend,
  jobId: string,
  bytes: Uint8Array
): Promise<string> {
  const safe = sanitizeId(jobId);
  if (!safe) throw new Error("Invalid job ID.");
  const filename = `${safe}.mp4`;
  await storage.putBinary(`jobs/${filename}`, bytes, "video/mp4");
  return filename;
}

export async function getJobVideoObject(
  storage: StorageBackend,
  filename: string,
  range?: ByteRangeRequest
): Promise<StoredBinaryObject | null> {
  const safe = sanitizeFilename(filename);
  if (!safe || !safe.endsWith(".mp4")) return null;
  return await storage.getBinary(`jobs/${safe}`, range);
}

export const ASSET_KINDS = [
  "source",
  "cutout",
  "concept",
  "video",
  "audio",
] as const;

export interface SavedAssetRef {
  id: string;
  label: string;
  kind: (typeof ASSET_KINDS)[number];
  filename: string;
  mimeType: string;
  url: string;
  style?: string;
  mode?: string;
  direction?: string;
  aspectRatio?: string;
  engine?: string;
}

export interface StoredProject {
  id: string;
  name: string;
  campaignType: "affiliate" | "own_brand" | "client_agency";
  clientOrBrandName: string;
  language: "tagalog" | "english";
  targetTone: string;
  visualStyle: string;
  aspectRatio: string;
  generationMode: "exact_product" | "ai_creative";
  motionPreset: string;
  motionPrompt: string;
  notes: string;
  analysis: unknown;
  assets: SavedAssetRef[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveProjectAssetInput {
  id: string;
  label: string;
  kind: SavedAssetRef["kind"];
  dataUrlOrBase64?: string;
  jobVideoFilename?: string;
  mimeType: string;
  style?: string;
  mode?: string;
  direction?: string;
  aspectRatio?: string;
  engine?: string;
}

export function extensionForMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("mp4")) return "mp4";
  if (lower.includes("webm")) return "webm";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("ogg")) return "ogg";
  return "jpg";
}

function decodeDataUrlOrBase64(raw: string): Uint8Array {
  const commaIdx = raw.indexOf(",");
  const b64 =
    raw.startsWith("data:") && commaIdx !== -1 ? raw.slice(commaIdx + 1) : raw;
  return Buffer.from(b64, "base64");
}

function buildAssetFilename(assetId: string, idx: number, mimeType: string): string {
  const ext = extensionForMime(mimeType || "image/png");
  const baseSlug =
    (assetId || `asset_${idx}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) ||
    `asset_${idx}`;
  return `${baseSlug}.${ext}`;
}

export async function listProjects(storage: StorageBackend): Promise<
  Array<
    Pick<
      StoredProject,
      | "id"
      | "name"
      | "campaignType"
      | "clientOrBrandName"
      | "visualStyle"
      | "aspectRatio"
      | "createdAt"
      | "updatedAt"
    > & { thumbnailUrl?: string; assetCount: number; videoCount: number }
  >
> {
  const keys = await storage.listKeys("projects/");
  const projectJsonKeys = keys.filter((k) =>
    /^projects\/[a-zA-Z0-9_-]{4,64}\/project\.json$/.test(k)
  );

  const loaded = await Promise.all(
    projectJsonKeys.map(async (key) => {
      try {
        const raw = await storage.getText(key);
        if (!raw) return null;
        const p = JSON.parse(raw) as StoredProject;
        const assets = Array.isArray(p.assets) ? p.assets : [];
        const thumb =
          assets.find((a) => a.kind === "concept") ||
          assets.find((a) => a.kind === "source") ||
          assets.find((a) => a.kind === "cutout");
        return {
          id: p.id,
          name: p.name,
          campaignType: p.campaignType,
          clientOrBrandName: p.clientOrBrandName,
          visualStyle: p.visualStyle,
          aspectRatio: p.aspectRatio,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          thumbnailUrl: thumb?.url,
          assetCount: assets.filter(
            (a) => a.kind === "concept" || a.kind === "cutout"
          ).length,
          videoCount: assets.filter((a) => a.kind === "video").length,
        };
      } catch {
        return null;
      }
    })
  );

  const list = loaded.filter((item): item is NonNullable<typeof item> => item !== null);
  list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return list;
}

export async function getProject(
  storage: StorageBackend,
  id: string
): Promise<StoredProject | null> {
  const safe = sanitizeId(id);
  if (!safe) return null;
  const raw = await storage.getText(`projects/${safe}/project.json`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredProject;
  } catch {
    return null;
  }
}

/**
 * Streams a single raw binary asset (or copies an existing server-generated
 * video job file) directly into `projects/{projectId}/assets/{filename}`.
 * Avoids multi-megabyte JSON/base64 decoding so saving large images and videos
 * stays well inside Cloudflare Workers Free's 10ms CPU limit.
 */
export async function uploadProjectAsset(
  storage: StorageBackend,
  params: {
    projectId: string;
    assetId: string;
    label: string;
    kind: SavedAssetRef["kind"];
    mimeType: string;
    body?: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | null;
    knownLength?: number;
    jobVideoFilename?: string;
    style?: string;
    mode?: string;
    direction?: string;
    aspectRatio?: string;
    engine?: string;
  }
): Promise<SavedAssetRef> {
  const safeProjectId = sanitizeId(params.projectId);
  if (!safeProjectId) {
    throw new Error("Invalid project ID.");
  }

  const baseMime =
    (params.mimeType || "image/png").split(";")[0].trim().toLowerCase() ||
    "image/png";
  const normalizedMime =
    baseMime === "image/jpg"
      ? "image/jpeg"
      : ALLOWED_ASSET_MIMES.has(baseMime)
        ? baseMime
        : "application/octet-stream";

  if (normalizedMime === "application/octet-stream") {
    throw new Error("Unsupported asset MIME type.");
  }

  const filename = buildAssetFilename(params.assetId, 0, normalizedMime);
  const targetKey = `projects/${safeProjectId}/assets/${filename}`;

  if (params.jobVideoFilename) {
    const safeJobFile = sanitizeFilename(params.jobVideoFilename);
    if (!safeJobFile || !safeJobFile.endsWith(".mp4")) {
      throw new Error("Invalid job video filename.");
    }
    const copied = await storage.copy(
      `jobs/${safeJobFile}`,
      targetKey,
      "video/mp4"
    );
    if (!copied) {
      throw new Error("Referenced video file was not found in storage.");
    }
  } else if (params.body) {
    if (params.knownLength === 0) {
      throw new Error("Asset payload is empty.");
    }
    if (
      typeof params.knownLength === "number" &&
      params.knownLength > MAX_ASSET_BYTES
    ) {
      throw new Error("Asset exceeds maximum allowed size (65 MB).");
    }
    await storage.putBinary(
      targetKey,
      params.body,
      normalizedMime,
      params.knownLength
    );
  } else {
    throw new Error("Missing binary asset body.");
  }

  return {
    id: params.assetId.slice(0, 64) || "asset",
    label: params.label.slice(0, 120) || filename,
    kind: ASSET_KINDS.includes(params.kind) ? params.kind : "concept",
    filename,
    mimeType: normalizedMime,
    url: `/api/projects/${safeProjectId}/assets/${filename}`,
    ...(params.style ? { style: params.style.slice(0, 40) } : {}),
    ...(params.mode ? { mode: params.mode.slice(0, 40) } : {}),
    ...(params.direction ? { direction: params.direction.slice(0, 240) } : {}),
    ...(params.aspectRatio ? { aspectRatio: params.aspectRatio.slice(0, 16) } : {}),
    ...(params.engine ? { engine: params.engine.slice(0, 40) } : {}),
  };
}

export async function saveProject(
  storage: StorageBackend,
  input: {
    id?: string;
    name: string;
    campaignType: StoredProject["campaignType"];
    clientOrBrandName: string;
    language: StoredProject["language"];
    targetTone: string;
    visualStyle: string;
    aspectRatio: string;
    generationMode: StoredProject["generationMode"];
    motionPreset: string;
    motionPrompt: string;
    notes: string;
    analysis: unknown;
    uploadedAssets?: SavedAssetRef[];
    assetsToSave?: SaveProjectAssetInput[];
    keepAssetFilenames?: string[];
  }
): Promise<StoredProject> {
  const safeExisting = input.id ? sanitizeId(input.id) : null;
  const id = safeExisting || `proj_${randomHex(6)}`;

  const existing = await getProject(storage, id);
  const now = new Date().toISOString();

  const savedAssets: SavedAssetRef[] = [];
  const upsertAsset = (ref: SavedAssetRef) => {
    const idx = savedAssets.findIndex((a) => a.filename === ref.filename);
    if (idx >= 0) {
      savedAssets[idx] = ref;
    } else {
      savedAssets.push(ref);
    }
  };

  if (existing && Array.isArray(input.keepAssetFilenames)) {
    const keepSet = new Set(input.keepAssetFilenames);
    for (const old of existing.assets) {
      if (keepSet.has(old.filename)) {
        upsertAsset(old);
      }
    }
  }

  // Register pre-streamed binary assets uploaded via PUT /api/projects/:id/assets/:assetId
  if (Array.isArray(input.uploadedAssets)) {
    for (const item of input.uploadedAssets) {
      const safeFile = sanitizeFilename(item?.filename);
      if (!safeFile) continue;
      const kind = ASSET_KINDS.includes(item.kind) ? item.kind : "concept";
      upsertAsset({
        id: String(item.id || safeFile).slice(0, 64),
        label: String(item.label || safeFile).slice(0, 120),
        kind,
        filename: safeFile,
        mimeType: String(item.mimeType || "image/png").slice(0, 80),
        url: `/api/projects/${id}/assets/${safeFile}`,
        ...(typeof item.style === "string" ? { style: item.style.slice(0, 40) } : {}),
        ...(typeof item.mode === "string" ? { mode: item.mode.slice(0, 40) } : {}),
        ...(typeof item.direction === "string"
          ? { direction: item.direction.slice(0, 240) }
          : {}),
        ...(typeof item.aspectRatio === "string"
          ? { aspectRatio: item.aspectRatio.slice(0, 16) }
          : {}),
        ...(typeof item.engine === "string" ? { engine: item.engine.slice(0, 40) } : {}),
      });
    }
  }

  // Backward-compatible support for inline base64 or job-video references
  if (Array.isArray(input.assetsToSave)) {
    for (let idx = 0; idx < input.assetsToSave.length; idx++) {
      const item = input.assetsToSave[idx];
      const baseMime =
        (item.mimeType || "image/png").split(";")[0].trim().toLowerCase() ||
        "image/png";
      const filename = buildAssetFilename(item.id, idx, baseMime);
      const targetKey = `projects/${id}/assets/${filename}`;

      if (item.jobVideoFilename) {
        const safeJobFile = sanitizeFilename(item.jobVideoFilename);
        if (!safeJobFile || !safeJobFile.endsWith(".mp4")) continue;
        const copied = await storage.copy(
          `jobs/${safeJobFile}`,
          targetKey,
          "video/mp4"
        );
        if (!copied) continue;
      } else if (item.dataUrlOrBase64) {
        const bytes = decodeDataUrlOrBase64(item.dataUrlOrBase64);
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) {
          continue;
        }
        await storage.putBinary(targetKey, bytes, baseMime);
      } else {
        continue;
      }

      upsertAsset({
        id: item.id,
        label: item.label,
        kind: ASSET_KINDS.includes(item.kind) ? item.kind : "concept",
        filename,
        mimeType: item.mimeType,
        url: `/api/projects/${id}/assets/${filename}`,
        style: item.style,
        mode: item.mode,
        direction: item.direction,
        aspectRatio: item.aspectRatio,
        engine: item.engine,
      });
    }
  }

  const project: StoredProject = {
    id,
    name: input.name.trim().slice(0, 120) || "Untitled Campaign",
    campaignType: input.campaignType,
    clientOrBrandName: input.clientOrBrandName.trim().slice(0, 120),
    language: input.language,
    targetTone: input.targetTone,
    visualStyle: input.visualStyle,
    aspectRatio: input.aspectRatio,
    generationMode: input.generationMode,
    motionPreset: input.motionPreset,
    motionPrompt: input.motionPrompt,
    notes: input.notes,
    analysis: input.analysis,
    assets: savedAssets,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await storage.putText(
    `projects/${id}/project.json`,
    JSON.stringify(project, null, 2)
  );
  return project;
}

export async function renameOrPatchProject(
  storage: StorageBackend,
  id: string,
  patch: Partial<
    Pick<
      StoredProject,
      | "name"
      | "campaignType"
      | "clientOrBrandName"
      | "notes"
      | "analysis"
      | "motionPreset"
      | "motionPrompt"
      | "visualStyle"
      | "aspectRatio"
    >
  >
): Promise<StoredProject | null> {
  const existing = await getProject(storage, id);
  if (!existing) return null;
  const updated: StoredProject = {
    ...existing,
    name:
      typeof patch.name === "string" && patch.name.trim()
        ? patch.name.trim().slice(0, 120)
        : existing.name,
    campaignType: patch.campaignType || existing.campaignType,
    clientOrBrandName:
      typeof patch.clientOrBrandName === "string"
        ? patch.clientOrBrandName.trim().slice(0, 120)
        : existing.clientOrBrandName,
    notes: typeof patch.notes === "string" ? patch.notes : existing.notes,
    analysis: patch.analysis !== undefined ? patch.analysis : existing.analysis,
    motionPreset: patch.motionPreset || existing.motionPreset,
    motionPrompt:
      typeof patch.motionPrompt === "string"
        ? patch.motionPrompt
        : existing.motionPrompt,
    visualStyle: patch.visualStyle || existing.visualStyle,
    aspectRatio: patch.aspectRatio || existing.aspectRatio,
    updatedAt: new Date().toISOString(),
  };
  await storage.putText(
    `projects/${existing.id}/project.json`,
    JSON.stringify(updated, null, 2)
  );
  return updated;
}

export async function deleteProject(
  storage: StorageBackend,
  id: string
): Promise<boolean> {
  const safe = sanitizeId(id);
  if (!safe) return false;
  return await storage.deletePrefix(`projects/${safe}/`);
}

export async function getProjectAssetObject(
  storage: StorageBackend,
  projectId: string,
  filename: string,
  range?: ByteRangeRequest
): Promise<{ object: StoredBinaryObject; safeFilename: string } | null> {
  const safeId = sanitizeId(projectId);
  const safeFile = sanitizeFilename(filename);
  if (!safeId || !safeFile) return null;
  const object = await storage.getBinary(
    `projects/${safeId}/assets/${safeFile}`,
    range
  );
  if (!object) return null;
  return { object, safeFilename: safeFile };
}
