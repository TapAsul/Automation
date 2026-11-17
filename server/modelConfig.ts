import type { StorageBackend } from "./storageAdapter.js";

export interface ModelConfiguration {
  analysisModel: string;
  analysisFallbackModel: string;
  imageGenModel: string;
  videoGenModel: string;
  ttsModel: string;
  ttsFallbackModel: string;
  updatedAt: string;
}

export interface ModelEnvOverrides {
  GEMINI_ANALYSIS_MODEL?: string;
  GEMINI_ANALYSIS_FALLBACK_MODEL?: string;
  GEMINI_IMAGE_MODEL?: string;
  GEMINI_VIDEO_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_TTS_FALLBACK_MODEL?: string;
}

const CONFIG_KEY = "model-config.json";
const CACHE_TTL_MS = 15_000;

const configCache = new WeakMap<
  StorageBackend,
  { value: ModelConfiguration; expiresAt: number }
>();

export function buildDefaultModelConfig(
  env?: ModelEnvOverrides
): ModelConfiguration {
  return {
    analysisModel: env?.GEMINI_ANALYSIS_MODEL || "gemini-4-hydrogen",
    analysisFallbackModel:
      env?.GEMINI_ANALYSIS_FALLBACK_MODEL || "gemini-3.1-flash-lite",
    imageGenModel: env?.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-lite-image",
    videoGenModel: env?.GEMINI_VIDEO_MODEL || "gemini-omni-1.2-flash",
    ttsModel: env?.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts",
    ttsFallbackModel:
      env?.GEMINI_TTS_FALLBACK_MODEL || "gemini-3.8-flash-tts",
    updatedAt: new Date().toISOString(),
  };
}

export async function getModelConfig(
  storage: StorageBackend,
  env?: ModelEnvOverrides
): Promise<ModelConfiguration> {
  const cached = configCache.get(storage);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.value };
  }

  const defaults = buildDefaultModelConfig(env);
  const raw = await storage.getText(CONFIG_KEY);
  if (!raw) {
    await storage.putText(CONFIG_KEY, JSON.stringify(defaults, null, 2));
    configCache.set(storage, {
      value: defaults,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { ...defaults };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ModelConfiguration>;
    const resolved: ModelConfiguration = {
      analysisModel: parsed.analysisModel || defaults.analysisModel,
      analysisFallbackModel:
        parsed.analysisFallbackModel || defaults.analysisFallbackModel,
      imageGenModel: parsed.imageGenModel || defaults.imageGenModel,
      videoGenModel: parsed.videoGenModel || defaults.videoGenModel,
      ttsModel: parsed.ttsModel || defaults.ttsModel,
      ttsFallbackModel: parsed.ttsFallbackModel || defaults.ttsFallbackModel,
      updatedAt: parsed.updatedAt || defaults.updatedAt,
    };
    configCache.set(storage, {
      value: resolved,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { ...resolved };
  } catch {
    return { ...defaults };
  }
}

export async function updateModelConfig(
  storage: StorageBackend,
  patch: Partial<Omit<ModelConfiguration, "updatedAt">>,
  env?: ModelEnvOverrides
): Promise<ModelConfiguration> {
  const current = await getModelConfig(storage, env);
  const cleanId = (val: unknown, fallback: string): string => {
    if (typeof val !== "string") return fallback;
    const trimmed = val.trim();
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(trimmed)) return fallback;
    return trimmed;
  };
  const next: ModelConfiguration = {
    analysisModel: cleanId(patch.analysisModel, current.analysisModel),
    analysisFallbackModel: cleanId(
      patch.analysisFallbackModel,
      current.analysisFallbackModel
    ),
    imageGenModel: cleanId(patch.imageGenModel, current.imageGenModel),
    videoGenModel: cleanId(patch.videoGenModel, current.videoGenModel),
    ttsModel: cleanId(patch.ttsModel, current.ttsModel),
    ttsFallbackModel: cleanId(patch.ttsFallbackModel, current.ttsFallbackModel),
    updatedAt: new Date().toISOString(),
  };
  await storage.putText(CONFIG_KEY, JSON.stringify(next, null, 2));
  configCache.set(storage, {
    value: next,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return { ...next };
}
