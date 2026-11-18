import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type {
  AspectRatioOption,
  BackdropPreset,
  ContentLanguage,
  GeneratedVideoResult,
  MotionPreset,
  PresentationMode,
  VideoScript,
  VideoStylePreset,
} from "../types/studio";
import {
  BACKDROP_THEMES,
  drawStudioBackdrop,
  loadImageElement,
} from "./backgroundRemover";
import { normalizeRecordedVideoBlob } from "./mp4Fixer";

export interface VideoRenderParams {
  cutoutDataUrl: string;
  backgroundDataUrl?: string | null;
  ugcTryOnDataUrl?: string | null;
  ugcPointingDataUrl?: string | null;
  presentationMode?: PresentationMode;
  productName: string;
  tagline: string;
  script: VideoScript;
  backdropPreset: BackdropPreset;
  stylePreset: VideoStylePreset;
  motionPreset?: MotionPreset;
  aspectRatio?: AspectRatioOption;
  accentHex: string;
  language?: ContentLanguage;
  voiceoverBase64?: string | null;
  showOverlays?: boolean;
  onProgress?: (percent: number) => void;
}

interface OverlaySprite {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

interface BufferedVideoChunk {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  meta?: EncodedVideoChunkMetadata;
}

interface BufferedAudioChunk {
  data: Uint8Array;
  type: "key" | "delta";
  meta?: EncodedAudioChunkMetadata;
}

const VALID_PRIMARIES = new Set(["bt709", "bt470bg", "smpte170m"]);
const VALID_TRANSFERS = new Set(["bt709", "smpte170m", "iec61966-2-1"]);
const VALID_MATRICES = new Set(["rgb", "bt709", "bt470bg", "smpte170m"]);

let sharedAudioCtx: AudioContext | null = null;

export function unlockAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === "suspended") {
    void sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS/i.test(
    navigator.userAgent || ""
  );
}

function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

function easeInOutSine(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return -(Math.cos(Math.PI * c) - 1) / 2;
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function bakeOverlaySprite(
  frameWidth: number,
  headline: string,
  sublabel: string,
  yCenter: number,
  accentHex: string,
  isCTA: boolean
): OverlaySprite {
  const pad = 36;
  const measureCanvas = document.createElement("canvas");
  measureCanvas.width = 16;
  measureCanvas.height = 16;
  const mCtx = measureCanvas.getContext("2d");
  const titleFont = `700 ${isCTA ? 34 : 38}px "Bricolage Grotesque", "Plus Jakarta Sans", sans-serif`;
  const subFont = `600 17px "Plus Jakarta Sans", sans-serif`;

  let lines = [headline.trim() || "Shop Now"];
  let maxLineW = 260;
  if (mCtx) {
    mCtx.font = titleFont;
    lines = wrapTextLines(mCtx, headline || "Shop Now", frameWidth - 130).slice(
      0,
      2
    );
    const titleWidths = lines.map((l) => mCtx.measureText(l).width);
    mCtx.font = subFont;
    const subWidth = sublabel ? mCtx.measureText(sublabel).width : 0;
    maxLineW = Math.max(...titleWidths, subWidth, 220);
  }

  const lineHeight = isCTA ? 44 : 48;
  const boxH = lines.length * lineHeight + (sublabel ? 52 : 28);
  const boxW = Math.min(
    frameWidth - 84,
    Math.max(300, Math.ceil(maxLineW + 64))
  );

  const sprite = document.createElement("canvas");
  sprite.width = boxW + pad * 2;
  sprite.height = boxH + pad * 2;
  const sCtx = sprite.getContext("2d");
  if (sCtx) {
    drawRoundedRect(sCtx, pad, pad, boxW, boxH, 18);
    sCtx.fillStyle = isCTA ? accentHex : "rgba(15, 23, 42, 0.88)";
    sCtx.shadowColor = "rgba(0, 0, 0, 0.28)";
    sCtx.shadowBlur = 22;
    sCtx.shadowOffsetY = 8;
    sCtx.fill();
    sCtx.shadowColor = "transparent";
    sCtx.shadowBlur = 0;
    sCtx.shadowOffsetY = 0;

    const centerX = pad + boxW / 2;
    sCtx.textAlign = "center";
    sCtx.textBaseline = "top";

    if (sublabel) {
      sCtx.font = subFont;
      sCtx.fillStyle = isCTA
        ? "rgba(255, 255, 255, 0.92)"
        : "rgba(255, 255, 255, 0.74)";
      sCtx.fillText(sublabel, centerX, pad + 13);
    }

    sCtx.font = titleFont;
    sCtx.fillStyle = "#FFFFFF";
    const textStartY = pad + (sublabel ? 38 : 15);
    lines.forEach((line, idx) => {
      sCtx.fillText(line, centerX, textStartY + idx * lineHeight);
    });
  }

  return {
    canvas: sprite,
    x: Math.round((frameWidth - boxW) / 2 - pad),
    y: Math.round(yCenter - boxH / 2 - pad),
  };
}

function bakeProductSprite(
  productImg: HTMLImageElement,
  targetW: number,
  targetH: number
): { canvas: HTMLCanvasElement; padRatioX: number; padRatioY: number } {
  const w = Math.max(2, Math.round(targetW));
  const h = Math.max(2, Math.round(targetH));
  const pad = 48;
  const sprite = document.createElement("canvas");
  sprite.width = w + pad * 2;
  sprite.height = h + pad * 2;
  const sCtx = sprite.getContext("2d");
  if (sCtx) {
    sCtx.shadowColor = "rgba(15, 23, 42, 0.22)";
    sCtx.shadowBlur = 26;
    sCtx.shadowOffsetY = 14;
    sCtx.drawImage(productImg, pad, pad, w, h);
  }
  return {
    canvas: sprite,
    padRatioX: pad / w,
    padRatioY: pad / h,
  };
}

function bakeContactShadowSprite(): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = 256;
  sprite.height = 64;
  const sCtx = sprite.getContext("2d");
  if (sCtx) {
    sCtx.save();
    sCtx.translate(128, 32);
    sCtx.scale(1, 0.24);
    const grad = sCtx.createRadialGradient(0, 0, 8, 0, 0, 120);
    grad.addColorStop(0, "rgba(15, 23, 42, 0.36)");
    grad.addColorStop(0.6, "rgba(15, 23, 42, 0.12)");
    grad.addColorStop(1, "rgba(15, 23, 42, 0)");
    sCtx.fillStyle = grad;
    sCtx.beginPath();
    sCtx.arc(0, 0, 120, 0, Math.PI * 2);
    sCtx.fill();
    sCtx.restore();
  }
  return sprite;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function buildAacLcAudioSpecificConfig(
  sampleRate: number,
  channels: number
): Uint8Array<ArrayBuffer> {
  const freqTable = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ];
  let freqIdx = freqTable.indexOf(sampleRate);
  if (freqIdx < 0) freqIdx = 3;
  const objectType = 2;
  const chCfg = Math.max(1, Math.min(2, channels));
  const out = new Uint8Array(new ArrayBuffer(2));
  out[0] = ((objectType << 3) | (freqIdx >> 1)) & 0xff;
  out[1] = (((freqIdx & 1) << 7) | (chCfg << 3)) & 0xff;
  return out;
}

function sanitizeVideoMeta(
  meta?: EncodedVideoChunkMetadata
): EncodedVideoChunkMetadata | undefined {
  if (!meta?.decoderConfig) return meta;
  const cs = meta.decoderConfig.colorSpace;
  const safeColorSpace: VideoColorSpaceInit =
    cs &&
    cs.primaries &&
    cs.transfer &&
    cs.matrix &&
    VALID_PRIMARIES.has(cs.primaries) &&
    VALID_TRANSFERS.has(cs.transfer) &&
    VALID_MATRICES.has(cs.matrix)
      ? {
          primaries: cs.primaries,
          transfer: cs.transfer,
          matrix: cs.matrix,
          fullRange: Boolean(cs.fullRange),
        }
      : {
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          fullRange: false,
        };
  return {
    ...meta,
    decoderConfig: {
      ...meta.decoderConfig,
      colorSpace: safeColorSpace,
    },
  };
}

async function pickWebCodecsVideoConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<VideoEncoderConfig | null> {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof VideoFrame === "undefined"
  ) {
    return null;
  }
  const codecs = [
    "avc1.420028",
    "avc1.42E028",
    "avc1.42001f",
    "avc1.42E01f",
    "avc1.4d0028",
    "avc1.640028",
  ];
  for (const codec of codecs) {
    const cfg: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: "realtime",
      avc: { format: "avc" },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) return cfg;
    } catch {
      // try next profile
    }
  }
  return null;
}

async function pickWebCodecsAudioConfig(): Promise<{
  config: AudioEncoderConfig;
  sampleRate: number;
  numberOfChannels: number;
} | null> {
  if (
    typeof AudioEncoder === "undefined" ||
    typeof AudioData === "undefined" ||
    typeof OfflineAudioContext === "undefined"
  ) {
    return null;
  }
  const candidates: Array<{
    sampleRate: number;
    numberOfChannels: number;
    bitrate: number;
  }> = [
    { sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
    { sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000 },
    { sampleRate: 48000, numberOfChannels: 1, bitrate: 96_000 },
    { sampleRate: 44100, numberOfChannels: 1, bitrate: 96_000 },
  ];
  for (const c of candidates) {
    const cfg: AudioEncoderConfig = {
      codec: "mp4a.40.2",
      sampleRate: c.sampleRate,
      numberOfChannels: c.numberOfChannels,
      bitrate: c.bitrate,
    };
    try {
      const support = await AudioEncoder.isConfigSupported(cfg);
      if (support.supported) {
        return {
          config: cfg,
          sampleRate: c.sampleRate,
          numberOfChannels: c.numberOfChannels,
        };
      }
    } catch {
      // try next AAC config
    }
  }
  return null;
}

async function renderAudioToBuffer(
  source: AudioBuffer,
  durationSec: number,
  sampleRate: number,
  channels: number
): Promise<AudioBuffer> {
  const totalFrames = Math.max(1024, Math.round(durationSec * sampleRate));
  const offline = new OfflineAudioContext(channels, totalFrames, sampleRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = source;
  if (source.duration > durationSec - 0.05) {
    const fade = offline.createGain();
    fade.gain.setValueAtTime(1, Math.max(0, durationSec - 0.3));
    fade.gain.linearRampToValueAtTime(0.001, durationSec);
    srcNode.connect(fade);
    fade.connect(offline.destination);
  } else {
    srcNode.connect(offline.destination);
  }
  srcNode.start(0);
  return offline.startRendering();
}

async function tryEncodeFastStartMp4WithWebCodecs(opts: {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  durationSec: number;
  audioBuffer: AudioBuffer | null;
  drawFrame: (elapsedSec: number) => void;
  onProgress?: (percent: number) => void;
}): Promise<GeneratedVideoResult | null> {
  const {
    canvas,
    width,
    height,
    fps,
    bitrate,
    durationSec,
    audioBuffer,
    drawFrame,
    onProgress,
  } = opts;

  const videoConfig = await pickWebCodecsVideoConfig(
    width,
    height,
    fps,
    bitrate
  );
  if (!videoConfig) return null;

  let audioChoice: Awaited<ReturnType<typeof pickWebCodecsAudioConfig>> = null;
  if (audioBuffer) {
    audioChoice = await pickWebCodecsAudioConfig();
    if (!audioChoice) return null;
  }

  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;

  try {
    const totalFrames = Math.max(fps, Math.round(durationSec * fps));
    const exactDurationSec = Number((totalFrames / fps).toFixed(2));
    const frameDurUs = Math.round(1_000_000 / fps);

    const videoChunks: BufferedVideoChunk[] = [];
    let videoError: Error | null = null;

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        videoChunks.push({
          data,
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? frameDurUs,
          meta: sanitizeVideoMeta(meta),
        });
      },
      error: (err) => {
        videoError = err instanceof Error ? err : new Error(String(err));
      },
    });
    videoEncoder.configure(videoConfig);

    const progressSpan = audioBuffer && audioChoice ? 82 : 95;
    for (let i = 0; i < totalFrames; i++) {
      if (videoError) throw videoError;
      while (videoEncoder.encodeQueueSize > 4) {
        if (videoError) throw videoError;
        await new Promise<void>((r) => window.setTimeout(r, 4));
      }

      drawFrame(i / fps);

      const tsUs = Math.round((i * 1_000_000) / fps);
      const nextTsUs = Math.round(((i + 1) * 1_000_000) / fps);
      const frame = new VideoFrame(canvas, {
        timestamp: tsUs,
        duration: Math.max(1, nextTsUs - tsUs),
      });
      try {
        videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      } finally {
        frame.close();
      }

      if (i % 6 === 0 || i === totalFrames - 1) {
        onProgress?.(
          Math.max(
            1,
            Math.min(
              progressSpan,
              Math.round(((i + 1) / totalFrames) * progressSpan)
            )
          )
        );
        await new Promise<void>((r) => window.setTimeout(r, 0));
      }
    }

    await videoEncoder.flush();
    videoEncoder.close();
    videoEncoder = null;

    if (videoError) throw videoError;
    if (videoChunks.length === 0) return null;

    const firstDesc = videoChunks.find(
      (c) => c.meta?.decoderConfig?.description
    )?.meta?.decoderConfig?.description;
    if (!firstDesc || firstDesc.byteLength === 0) {
      return null;
    }

    const audioChunks: BufferedAudioChunk[] = [];
    let audioSampleRate = 48000;
    let audioChannels = 2;

    if (audioBuffer && audioChoice) {
      audioSampleRate = audioChoice.sampleRate;
      audioChannels = audioChoice.numberOfChannels;
      const rendered = await renderAudioToBuffer(
        audioBuffer,
        exactDurationSec,
        audioSampleRate,
        audioChannels
      );

      let audioError: Error | null = null;
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          audioChunks.push({
            data,
            type: chunk.type,
            meta,
          });
        },
        error: (err) => {
          audioError = err instanceof Error ? err : new Error(String(err));
        },
      });
      audioEncoder.configure(audioChoice.config);

      const hop = 1024;
      for (let offset = 0; offset < rendered.length; offset += hop) {
        if (audioError) throw audioError;
        while (audioEncoder.encodeQueueSize > 16) {
          if (audioError) throw audioError;
          await new Promise<void>((r) => window.setTimeout(r, 2));
        }
        const frameCount = Math.min(hop, rendered.length - offset);
        const planar = new Float32Array(
          new ArrayBuffer(frameCount * audioChannels * 4)
        );
        for (let ch = 0; ch < audioChannels; ch++) {
          planar.set(
            rendered.getChannelData(ch).subarray(offset, offset + frameCount),
            ch * frameCount
          );
        }
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate: audioSampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: audioChannels,
          timestamp: Math.round((offset * 1_000_000) / audioSampleRate),
          data: planar,
        });
        try {
          audioEncoder.encode(audioData);
        } finally {
          audioData.close();
        }
      }

      await audioEncoder.flush();
      audioEncoder.close();
      audioEncoder = null;
      if (audioError) throw audioError;
      onProgress?.(95);
    }

    const includeAudio = Boolean(audioChoice && audioChunks.length > 0);
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: "avc",
        width,
        height,
        frameRate: fps,
      },
      ...(includeAudio
        ? {
            audio: {
              codec: "aac",
              sampleRate: audioSampleRate,
              numberOfChannels: audioChannels,
            },
          }
        : {}),
      fastStart: "in-memory",
      firstTimestampBehavior: "strict",
    });

    let hasReordering = false;
    let ctoShiftUs = 0;
    for (let i = 0; i < videoChunks.length; i++) {
      const dtsUs = Math.round((i * 1_000_000) / fps);
      const ptsUs = videoChunks[i].timestamp;
      if (i > 0 && ptsUs < videoChunks[i - 1].timestamp) {
        hasReordering = true;
      }
      if (dtsUs - ptsUs > ctoShiftUs) {
        ctoShiftUs = dtsUs - ptsUs;
      }
    }

    for (let i = 0; i < videoChunks.length; i++) {
      const c = videoChunks[i];
      const dtsUs = Math.round((i * 1_000_000) / fps);
      const nextDtsUs = Math.round(((i + 1) * 1_000_000) / fps);
      const exactDurUs = Math.max(1, nextDtsUs - dtsUs);
      if (hasReordering) {
        const shiftedPtsUs = Math.max(dtsUs, c.timestamp + ctoShiftUs);
        const ctoUs = Math.max(0, shiftedPtsUs - dtsUs);
        muxer.addVideoChunkRaw(
          c.data,
          c.type,
          shiftedPtsUs,
          exactDurUs,
          c.meta,
          ctoUs
        );
      } else {
        muxer.addVideoChunkRaw(c.data, c.type, dtsUs, exactDurUs, c.meta, 0);
      }
    }

    if (includeAudio) {
      const maxVideoUs = Math.round(exactDurationSec * 1_000_000);
      const fallbackAsc = buildAacLcAudioSpecificConfig(
        audioSampleRate,
        audioChannels
      );
      let providedAsc = false;

      for (let i = 0; i < audioChunks.length; i++) {
        const c = audioChunks[i];
        const tsUs = Math.round((i * 1024 * 1_000_000) / audioSampleRate);
        if (tsUs >= maxVideoUs) break;
        const nextTsUs = Math.round(
          ((i + 1) * 1024 * 1_000_000) / audioSampleRate
        );
        const durUs = Math.min(
          Math.max(1, nextTsUs - tsUs),
          Math.max(1, maxVideoUs - tsUs)
        );
        let meta = c.meta;
        if (!providedAsc) {
          const existingDesc = meta?.decoderConfig?.description;
          if (!existingDesc || existingDesc.byteLength === 0) {
            meta = {
              ...meta,
              decoderConfig: {
                codec: "mp4a.40.2",
                sampleRate: audioSampleRate,
                numberOfChannels: audioChannels,
                ...meta?.decoderConfig,
                description: fallbackAsc,
              },
            };
          }
          providedAsc = true;
        }
        muxer.addAudioChunkRaw(c.data, c.type, tsUs, durUs, meta);
      }
    }

    muxer.finalize();
    const mp4Blob = new Blob([target.buffer], { type: "video/mp4" });
    if (mp4Blob.size < 256) return null;

    const videoUrl = URL.createObjectURL(mp4Blob);
    onProgress?.(100);
    return {
      videoUrl,
      blob: mp4Blob,
      mimeType: "video/mp4",
      extension: "mp4",
      durationSec: exactDurationSec,
      resolution: `${width}x${height}`,
      engine: "local_compositor",
    };
  } catch {
    if (videoEncoder && videoEncoder.state !== "closed") {
      try {
        videoEncoder.close();
      } catch {
        // ignore
      }
    }
    if (audioEncoder && audioEncoder.state !== "closed") {
      try {
        audioEncoder.close();
      } catch {
        // ignore
      }
    }
    return null;
  }
}

function pickSupportedRecorderMime(hasAudio: boolean): {
  mimeType: string;
  extension: "mp4" | "webm";
} {
  const candidates: Array<{ mime: string; ext: "mp4" | "webm" }> = hasAudio
    ? [
        { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" },
        { mime: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" },
        { mime: "video/mp4", ext: "mp4" },
        { mime: "video/webm;codecs=h264,opus", ext: "webm" },
        { mime: "video/webm;codecs=vp8,opus", ext: "webm" },
        { mime: "video/webm", ext: "webm" },
      ]
    : [
        { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
        { mime: "video/mp4;codecs=avc1", ext: "mp4" },
        { mime: "video/mp4", ext: "mp4" },
        { mime: "video/webm;codecs=h264", ext: "webm" },
        { mime: "video/webm;codecs=vp8", ext: "webm" },
        { mime: "video/webm", ext: "webm" },
      ];

  for (const c of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(c.mime)
    ) {
      return { mimeType: c.mime, extension: c.ext };
    }
  }
  return { mimeType: "video/mp4", extension: "mp4" };
}

export async function renderShowcaseVideo(
  params: VideoRenderParams
): Promise<GeneratedVideoResult> {
  const {
    cutoutDataUrl,
    backgroundDataUrl,
    productName,
    script,
    backdropPreset,
    stylePreset,
    motionPreset = "Cinematic Product Reveal",
    aspectRatio = "9:16",
    accentHex,
    language = "tagalog",
    voiceoverBase64,
    showOverlays = true,
    onProgress,
  } = params;

  const mobile = isMobileBrowser();
  const isWide = aspectRatio === "16:9";
  const width = isWide ? 1280 : 720;
  const height = isWide ? 720 : 1280;
  const fps = 30;
  const videoBitrate = mobile ? 3_200_000 : 4_500_000;

  const [productImg, bgImg] = await Promise.all([
    loadImageElement(cutoutDataUrl),
    backgroundDataUrl
      ? loadImageElement(backgroundDataUrl).catch(() => null)
      : Promise.resolve(null),
  ]);

  const theme = BACKDROP_THEMES[backdropPreset];
  const validAccent = /^#[0-9A-Fa-f]{6}$/.test(accentHex)
    ? accentHex
    : "#E11D48";

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Unable to initialize 2D video canvas.");

  let audioCtx: AudioContext | null = null;
  let decodedAudio: AudioBuffer | null = null;
  const durationSec = 12.0;

  if (voiceoverBase64) {
    audioCtx = unlockAudioContext() || new AudioContext();
    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }
    decodedAudio = await audioCtx.decodeAudioData(
      base64ToArrayBuffer(voiceoverBase64)
    );
  }

  let backdropSprite: HTMLCanvasElement | null = null;
  if (!bgImg) {
    backdropSprite = document.createElement("canvas");
    backdropSprite.width = width;
    backdropSprite.height = height;
    const bCtx = backdropSprite.getContext("2d", { alpha: false });
    if (bCtx) {
      drawStudioBackdrop(bCtx, width, height, theme, validAccent);
    }
  }

  const maxProdW = isWide ? 440 : 520;
  const maxProdH = isWide ? 430 : 510;
  const baseFit = Math.min(
    maxProdW / Math.max(1, productImg.naturalWidth),
    maxProdH / Math.max(1, productImg.naturalHeight)
  );
  const baseProdW = productImg.naturalWidth * baseFit;
  const baseProdH = productImg.naturalHeight * baseFit;
  const productSprite = bakeProductSprite(
    productImg,
    baseProdW * 1.15,
    baseProdH * 1.15
  );
  const shadowSprite = bakeContactShadowSprite();

  const beat1End = durationSec * 0.31;
  const beat2End = durationSec * 0.65;
  const benefitLabel =
    language === "tagalog" ? "Bakit Sulit Ito" : "Key Highlight";
  const ctaLabel =
    language === "tagalog"
      ? "I-click ang Yellow Basket"
      : "Tap Yellow Basket Below";

  const overlaySprites = showOverlays
    ? {
        beat1: bakeOverlaySprite(
          width,
          script.beat1Hook,
          productName.slice(0, 34),
          isWide ? 130 : 195,
          validAccent,
          false
        ),
        beat2: bakeOverlaySprite(
          width,
          script.beat2Benefit,
          benefitLabel,
          isWide ? 130 : 195,
          validAccent,
          false
        ),
        beat3: bakeOverlaySprite(
          width,
          script.beat3Offer,
          ctaLabel,
          isWide ? height - 125 : 1020,
          validAccent,
          true
        ),
      }
    : null;

  const particles = Array.from({ length: mobile ? 14 : 20 }, (_, i) => ({
    x: ((i * 137.5) % 100) / 100,
    y: ((i * 73.1) % 100) / 100,
    r: 1.5 + (i % 3) * 1.2,
    speed: 0.015 + (i % 4) * 0.009,
  }));

  const beamColor =
    motionPreset === "Dramatic Lighting Reveal"
      ? "rgba(255,255,255,0.2)"
      : motionPreset === "Luxury Commercial"
        ? "rgba(253,230,138,0.14)"
        : theme.isDark
          ? "rgba(255,255,255,0.07)"
          : "rgba(255,255,255,0.2)";
  const particleFill = theme.isDark
    ? "rgba(255,255,255,0.18)"
    : "rgba(255,255,255,0.4)";
  const sweepSpeed = motionPreset === "Dramatic Lighting Reveal" ? 2.2 : 4.2;
  const pedestalSurfaceY = height * (isWide ? 0.78 : 0.695);
  const baseCenterY = pedestalSurfaceY - baseProdH * 0.5;

  const drawBeatSprite = (sprite: OverlaySprite, beatProgress: number) => {
    const alpha = easeOutCubic(Math.min(1, beatProgress * 3.5));
    const slideY = (1 - easeOutCubic(Math.min(1, beatProgress * 3))) * 22;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite.canvas, sprite.x, sprite.y + slideY);
    ctx.globalAlpha = 1;
  };

  const drawFrame = (elapsedSec: number) => {
    const t = Math.min(1, Math.max(0, elapsedSec / durationSec));

    if (bgImg) {
      const bgScale =
        motionPreset === "Slow Camera Push" ||
        motionPreset === "Cinematic Product Reveal"
          ? 1.02 + 0.12 * easeInOutSine(t)
          : motionPreset === "Rotating Product Display" ||
              motionPreset === "Luxury Commercial"
            ? 1.08
            : 1.02 + 0.08 * easeInOutSine(t);
      const bgPanX =
        motionPreset === "Rotating Product Display" ||
        motionPreset === "Luxury Commercial"
          ? Math.sin(elapsedSec * 0.85) * 22
          : Math.sin(elapsedSec * 0.45) * 10;
      const bw = width * bgScale;
      const bh = height * bgScale;
      ctx.drawImage(
        bgImg,
        (width - bw) / 2 + bgPanX,
        (height - bh) / 2,
        bw,
        bh
      );
    } else if (backdropSprite) {
      ctx.drawImage(backdropSprite, 0, 0);
    }

    const sweepProgress = easeInOutSine((elapsedSec % sweepSpeed) / sweepSpeed);
    const sweepX = -width * 0.4 + sweepProgress * width * 1.8;
    const beamGrad = ctx.createLinearGradient(
      sweepX - 190,
      0,
      sweepX + 190,
      height
    );
    beamGrad.addColorStop(0, "rgba(255,255,255,0)");
    beamGrad.addColorStop(0.5, beamColor);
    beamGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = beamGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = particleFill;
    ctx.beginPath();
    for (const p of particles) {
      const py = ((p.y - elapsedSec * p.speed + 2) % 1) * height * 0.78;
      const px = p.x * width + Math.sin(elapsedSec * 1.4 + p.y * 10) * 14;
      ctx.moveTo(px + p.r, py);
      ctx.arc(px, py, p.r, 0, Math.PI * 2);
    }
    ctx.fill();

    const enterP = easeOutCubic(elapsedSec / 0.75);
    const productAlpha = Math.min(1, 0.9 + 0.1 * enterP);
    let floatOffset = Math.sin(elapsedSec * 1.9) * 6;
    let panX = 0;
    let zoomFactor = 0.96 + 0.08 * easeOutCubic(t);
    let tiltAngle = Math.sin(elapsedSec * 1.1) * 0.012;

    if (motionPreset === "Cinematic Product Reveal") {
      zoomFactor = 0.9 + 0.16 * easeOutCubic(t);
      floatOffset = Math.sin(elapsedSec * 1.3) * 5;
      tiltAngle = Math.sin(elapsedSec * 0.9) * 0.016;
    } else if (motionPreset === "Slow Camera Push") {
      zoomFactor = 0.92 + 0.2 * easeInOutSine(t);
      floatOffset = Math.sin(elapsedSec * 1.1) * 3;
    } else if (motionPreset === "Floating Product Showcase") {
      floatOffset = Math.sin(elapsedSec * 2.5) * 18;
      tiltAngle = Math.sin(elapsedSec * 1.7) * 0.032;
      zoomFactor = 0.94 + 0.07 * Math.sin(t * Math.PI);
    } else if (motionPreset === "Rotating Product Display") {
      tiltAngle = Math.sin(elapsedSec * 1.45) * 0.055;
      panX = Math.sin(elapsedSec * 1.1) * 14;
      zoomFactor = 0.96 + 0.07 * easeInOutSine(t);
    } else if (motionPreset === "Luxury Commercial") {
      panX = Math.sin(elapsedSec * 1.05) * 20;
      tiltAngle = Math.cos(elapsedSec * 1.05) * 0.024;
      zoomFactor = 0.94 + 0.11 * easeInOutSine(t);
    } else if (motionPreset === "Minimalist Product Presentation") {
      floatOffset = Math.sin(elapsedSec * 1.1) * 3;
      tiltAngle = 0;
      zoomFactor = 0.97 + 0.05 * easeInOutSine(t);
    } else if (motionPreset === "Dramatic Lighting Reveal") {
      zoomFactor = 0.98 + 0.09 * easeOutCubic(t);
      tiltAngle = Math.sin(elapsedSec * 0.8) * 0.01;
    } else if (motionPreset === "TikTok Product Advertisement") {
      floatOffset = Math.sin(elapsedSec * 2.4) * 10;
      panX = Math.sin(elapsedSec * 1.4) * 10;
      zoomFactor = 0.94 + 0.13 * easeOutCubic(t);
    }

    if (stylePreset === "energetic") {
      floatOffset *= 1.18;
    }

    const prodW = baseProdW * zoomFactor;
    const prodH = baseProdH * zoomFactor;
    const centerX = width / 2 + panX;
    const centerY = baseCenterY + (1 - enterP) * 36 + floatOffset;

    const shadowScale = Math.max(0.75, 1 - floatOffset * 0.007);
    const shadowW = prodW * 1.05 * shadowScale;
    const shadowH = 58 * shadowScale;
    const shadowY = pedestalSurfaceY + 8;
    ctx.drawImage(
      shadowSprite,
      centerX - shadowW / 2,
      shadowY - shadowH / 2,
      shadowW,
      shadowH
    );

    const drawW = prodW * (1 + productSprite.padRatioX * 2);
    const drawH = prodH * (1 + productSprite.padRatioY * 2);
    ctx.save();
    ctx.globalAlpha = productAlpha;
    ctx.translate(centerX, centerY);
    ctx.rotate(tiltAngle);
    ctx.drawImage(productSprite.canvas, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    if (overlaySprites) {
      if (elapsedSec < beat1End) {
        drawBeatSprite(overlaySprites.beat1, elapsedSec / beat1End);
      } else if (elapsedSec < beat2End) {
        drawBeatSprite(
          overlaySprites.beat2,
          (elapsedSec - beat1End) / (beat2End - beat1End)
        );
      } else {
        drawBeatSprite(
          overlaySprites.beat3,
          (elapsedSec - beat2End) / (durationSec - beat2End)
        );
      }
    }

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(36, 48, width - 72, 4);
    ctx.fillStyle = validAccent;
    ctx.fillRect(36, 48, (width - 72) * t, 4);
  };

  const webCodecsResult = await tryEncodeFastStartMp4WithWebCodecs({
    canvas,
    width,
    height,
    fps,
    bitrate: videoBitrate,
    durationSec,
    audioBuffer: decodedAudio,
    drawFrame,
    onProgress,
  });
  if (webCodecsResult) {
    return webCodecsResult;
  }

  const canvasStream = canvas.captureStream(fps);
  const combinedStream = new MediaStream(canvasStream.getVideoTracks());
  let audioSource: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null;
  let hasAudioTrack = false;

  if (decodedAudio && audioCtx) {
    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }
    const dest = audioCtx.createMediaStreamDestination();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = decodedAudio;
    audioSource.connect(gainNode);
    gainNode.connect(dest);
    for (const track of dest.stream.getAudioTracks()) {
      combinedStream.addTrack(track);
      hasAudioTrack = true;
    }
  }

  const { mimeType, extension } = pickSupportedRecorderMime(hasAudioTrack);
  const recorder = new MediaRecorder(
    combinedStream,
    MediaRecorder.isTypeSupported(mimeType)
      ? {
          mimeType,
          videoBitsPerSecond: videoBitrate,
          audioBitsPerSecond: 128_000,
        }
      : {
          videoBitsPerSecond: videoBitrate,
          audioBitsPerSecond: 128_000,
        }
  );

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  return new Promise<GeneratedVideoResult>((resolve, reject) => {
    let rafId = 0;
    let settled = false;

    const cleanupTracks = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      if (audioSource) {
        try {
          audioSource.stop();
          audioSource.disconnect();
        } catch {
          // ignore
        }
      }
      if (gainNode) {
        try {
          gainNode.disconnect();
        } catch {
          // ignore
        }
      }
      for (const track of combinedStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    };

    recorder.onstop = () => {
      void (async () => {
        if (settled) return;
        settled = true;
        cleanupTracks();
        const effectiveMime =
          recorder.mimeType ||
          mimeType ||
          (extension === "mp4" ? "video/mp4" : "video/webm");
        const rawBlob = new Blob(chunks, { type: effectiveMime });
        const fixedBlob = await normalizeRecordedVideoBlob(
          rawBlob,
          effectiveMime,
          durationSec,
          fps
        );
        const finalExt: "mp4" | "webm" = fixedBlob.type.includes("webm")
          ? "webm"
          : "mp4";
        const finalMime = finalExt === "mp4" ? "video/mp4" : "video/webm";
        const videoUrl = URL.createObjectURL(fixedBlob);
        onProgress?.(100);
        resolve({
          videoUrl,
          blob: fixedBlob,
          mimeType: finalMime,
          extension: finalExt,
          durationSec,
          resolution: `${width}x${height}`,
          engine: "local_compositor",
        });
      })();
    };

    recorder.onerror = () => {
      if (settled) return;
      settled = true;
      cleanupTracks();
      reject(new Error("Video encoding failed in browser."));
    };

    drawFrame(0);
    recorder.start();
    if (audioSource) {
      audioSource.start(0);
    }

    const startTime = performance.now();
    let lastProgressUpdate = 0;

    const tick = (now: number) => {
      const elapsedSec = (now - startTime) / 1000;
      if (elapsedSec >= durationSec) {
        drawFrame(durationSec);
        if (recorder.state === "recording") {
          recorder.stop();
        }
        return;
      }
      drawFrame(elapsedSec);
      if (now - lastProgressUpdate > 180) {
        lastProgressUpdate = now;
        onProgress?.(Math.min(97, Math.round((elapsedSec / durationSec) * 97)));
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
  });
}