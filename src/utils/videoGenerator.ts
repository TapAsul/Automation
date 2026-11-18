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
  yCenter: number;
}

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
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * Math.min(1, Math.max(0, t))) - 1) / 2;
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.trim().split(/\s+/);
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
) {
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

/**
 * Prefers hardware-accelerated H.264 MP4 first (smooth on iPhone & Android),
 * then hardware-friendly VP8 WebM before CPU-heavy VP9.
 */
function pickSupportedMimeType(hasAudio: boolean): {
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
        { mime: "video/webm;codecs=vp9,opus", ext: "webm" },
        { mime: "video/webm", ext: "webm" },
      ]
    : [
        { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
        { mime: "video/mp4;codecs=avc1", ext: "mp4" },
        { mime: "video/mp4", ext: "mp4" },
        { mime: "video/webm;codecs=h264", ext: "webm" },
        { mime: "video/webm;codecs=vp8", ext: "webm" },
        { mime: "video/webm;codecs=vp9", ext: "webm" },
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
  return { mimeType: "video/webm", extension: "webm" };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Pre-renders an overlay caption card (including its drop shadow) once so
 * the per-frame loop never runs shadowBlur or measureText on mobile CPUs.
 */
function buildOverlaySprite(
  frameWidth: number,
  headline: string,
  sublabel: string,
  yCenter: number,
  accentColor: string,
  isCTA: boolean
): OverlaySprite {
  const pad = 36;
  const measure = document.createElement("canvas").getContext("2d");
  const fontSize = isCTA ? 34 : 38;
  const lineHeight = isCTA ? 44 : 48;

  let lines = [headline.trim()];
  let maxLineW = 260;

  if (measure) {
    measure.font = `700 ${fontSize}px "Bricolage Grotesque", "Plus Jakarta Sans", sans-serif`;
    lines = wrapTextLines(measure, headline, frameWidth - 130).slice(0, 2);
    const lineWidths = lines.map((l) => measure.measureText(l).width);
    measure.font = `600 17px "Plus Jakarta Sans", sans-serif`;
    const subW = sublabel ? measure.measureText(sublabel).width : 0;
    maxLineW = Math.max(...lineWidths, subW, 0);
  }

  const boxHeight = lines.length * lineHeight + (sublabel ? 52 : 28);
  const boxW = Math.min(frameWidth - 84, Math.max(300, Math.ceil(maxLineW + 64)));

  const sprite = document.createElement("canvas");
  sprite.width = boxW + pad * 2;
  sprite.height = boxHeight + pad * 2;
  const sctx = sprite.getContext("2d");

  if (sctx) {
    const bx = pad;
    const by = pad;
    const cx = sprite.width / 2;

    sctx.save();
    drawRoundedRect(sctx, bx, by, boxW, boxHeight, 18);
    sctx.fillStyle = isCTA ? accentColor : "rgba(15, 23, 42, 0.88)";
    sctx.shadowColor = "rgba(0, 0, 0, 0.28)";
    sctx.shadowBlur = 22;
    sctx.shadowOffsetY = 8;
    sctx.fill();
    sctx.restore();

    if (sublabel) {
      sctx.font = `600 17px "Plus Jakarta Sans", sans-serif`;
      sctx.fillStyle = isCTA
        ? "rgba(255, 255, 255, 0.92)"
        : "rgba(255, 255, 255, 0.74)";
      sctx.textAlign = "center";
      sctx.textBaseline = "top";
      sctx.fillText(sublabel, cx, by + 13);
    }

    sctx.font = `700 ${fontSize}px "Bricolage Grotesque", "Plus Jakarta Sans", sans-serif`;
    sctx.fillStyle = "#FFFFFF";
    sctx.textAlign = "center";
    sctx.textBaseline = "top";
    const textStartY = by + (sublabel ? 38 : 15);
    lines.forEach((line, idx) => {
      sctx.fillText(line, cx, textStartY + idx * lineHeight);
    });
  }

  return { canvas: sprite, yCenter };
}

/**
 * Pre-renders the product cutout + soft drop shadow once onto an offscreen
 * canvas, eliminating slow per-frame Gaussian blur during mobile encoding.
 */
function buildProductSprite(
  productImg: HTMLImageElement,
  targetW: number,
  targetH: number
): { canvas: HTMLCanvasElement; pad: number; innerW: number; innerH: number } {
  const pad = 48;
  const innerW = Math.max(1, Math.round(targetW));
  const innerH = Math.max(1, Math.round(targetH));
  const sprite = document.createElement("canvas");
  sprite.width = innerW + pad * 2;
  sprite.height = innerH + pad * 2;
  const sctx = sprite.getContext("2d");
  if (sctx) {
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.shadowColor = "rgba(15, 23, 42, 0.24)";
    sctx.shadowBlur = 26;
    sctx.shadowOffsetY = 14;
    sctx.drawImage(productImg, pad, pad, innerW, innerH);
  }
  return { canvas: sprite, pad, innerW, innerH };
}

function buildContactShadowSprite(): HTMLCanvasElement {
  const w = 360;
  const h = 80;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const sctx = c.getContext("2d");
  if (sctx) {
    sctx.save();
    sctx.translate(w / 2, h / 2);
    sctx.scale(1, h / w);
    const g = sctx.createRadialGradient(0, 0, 8, 0, 0, w * 0.48);
    g.addColorStop(0, "rgba(15, 23, 42, 0.38)");
    g.addColorStop(0.6, "rgba(15, 23, 42, 0.13)");
    g.addColorStop(1, "rgba(15, 23, 42, 0)");
    sctx.fillStyle = g;
    sctx.beginPath();
    sctx.arc(0, 0, w * 0.48, 0, Math.PI * 2);
    sctx.fill();
    sctx.restore();
  }
  return c;
}

function buildLightBeamSprite(beamColor: string, height: number): HTMLCanvasElement {
  const w = 360;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = height;
  const sctx = c.getContext("2d");
  if (sctx) {
    const grad = sctx.createLinearGradient(0, 0, w, height * 0.35);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, beamColor);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, w, height);
  }
  return c;
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

  const isWide = aspectRatio === "16:9";
  const width = isWide ? 1280 : 720;
  const height = isWide ? 720 : 1280;
  const fps = 30;
  const mobile = isMobileBrowser();

  if (typeof document !== "undefined" && document.fonts?.ready) {
    await Promise.race([
      document.fonts.ready,
      new Promise((r) => window.setTimeout(r, 400)),
    ]);
  }

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

  // Pre-bake background layer once (avoids redrawing complex scenes or 4K images per frame)
  const bgSprite = document.createElement("canvas");
  if (bgImg) {
    const overscan = 1.15;
    bgSprite.width = Math.round(width * overscan);
    bgSprite.height = Math.round(height * overscan);
    const bctx = bgSprite.getContext("2d", { alpha: false });
    if (bctx) {
      const cover = Math.max(
        bgSprite.width / (bgImg.naturalWidth || 1),
        bgSprite.height / (bgImg.naturalHeight || 1)
      );
      const dw = bgImg.naturalWidth * cover;
      const dh = bgImg.naturalHeight * cover;
      bctx.drawImage(
        bgImg,
        (bgSprite.width - dw) / 2,
        (bgSprite.height - dh) / 2,
        dw,
        dh
      );
    }
  } else {
    bgSprite.width = width;
    bgSprite.height = height;
    const bctx = bgSprite.getContext("2d", { alpha: false });
    if (bctx) {
      drawStudioBackdrop(bctx, width, height, theme, validAccent);
    }
  }

  // Pre-bake product cutout + drop shadow once at crisp peak zoom resolution
  const maxProdW = isWide ? 440 : 520;
  const maxProdH = isWide ? 430 : 510;
  const baseFit = Math.min(
    maxProdW / (productImg.naturalWidth || 1),
    maxProdH / (productImg.naturalHeight || 1)
  );
  const peakZoom = 1.14;
  const baseProdW = productImg.naturalWidth * baseFit;
  const baseProdH = productImg.naturalHeight * baseFit;
  const productSprite = buildProductSprite(
    productImg,
    baseProdW * peakZoom,
    baseProdH * peakZoom
  );
  const shadowSprite = buildContactShadowSprite();

  const beamColor =
    motionPreset === "Dramatic Lighting Reveal"
      ? "rgba(255,255,255,0.2)"
      : motionPreset === "Luxury Commercial"
        ? "rgba(253,230,138,0.14)"
        : theme.isDark
          ? "rgba(255,255,255,0.07)"
          : "rgba(255,255,255,0.22)";
  const beamSprite = buildLightBeamSprite(beamColor, height);

  // Pre-bake all 3 beat caption cards once
  let beatSprites: [OverlaySprite, OverlaySprite, OverlaySprite] | null = null;
  if (showOverlays) {
    const benefitLabel =
      language === "tagalog" ? "Bakit Sulit Ito" : "Key Highlight";
    const ctaLabel =
      language === "tagalog"
        ? "I-click ang Yellow Basket"
        : "Tap Yellow Basket Below";
    const topBeatY = isWide ? 120 : 195;
    const ctaBeatY = isWide ? height - 115 : 1020;

    beatSprites = [
      buildOverlaySprite(
        width,
        script.beat1Hook,
        productName.slice(0, 34),
        topBeatY,
        validAccent,
        false
      ),
      buildOverlaySprite(
        width,
        script.beat2Benefit,
        benefitLabel,
        topBeatY,
        validAccent,
        false
      ),
      buildOverlaySprite(
        width,
        script.beat3Offer,
        ctaLabel,
        ctaBeatY,
        validAccent,
        true
      ),
    ];
  }

  // Opaque root canvas enables fast mobile GPU compositing
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Unable to initialize 2D video canvas.");
  ctx.imageSmoothingEnabled = true;

  const canvasStream = canvas.captureStream(fps);

  let audioCtx: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null;
  let durationSec = 9.0;
  const combinedStream = new MediaStream(canvasStream.getVideoTracks());
  let hasAudioTrack = false;

  if (voiceoverBase64) {
    audioCtx = unlockAudioContext() || new AudioContext();
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    const audioBuf = await audioCtx.decodeAudioData(
      base64ToArrayBuffer(voiceoverBase64)
    );
    durationSec = Math.max(8.5, Math.min(15.0, audioBuf.duration + 0.6));

    const dest = audioCtx.createMediaStreamDestination();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;

    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = audioBuf;
    audioSource.connect(gainNode);
    gainNode.connect(dest);

    for (const track of dest.stream.getAudioTracks()) {
      combinedStream.addTrack(track);
      hasAudioTrack = true;
    }
  }

  const { mimeType, extension } = pickSupportedMimeType(hasAudioTrack);
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    // Tuned for crisp 720p TikTok ads without choking mobile hardware encoders
    videoBitsPerSecond: mobile ? 3_200_000 : 4_500_000,
    audioBitsPerSecond: 128_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  const particleCount = mobile ? 14 : 22;
  const particles = Array.from({ length: particleCount }, (_, i) => ({
    x: ((i * 137.5) % 100) / 100,
    y: ((i * 73.1) % 100) / 100,
    size: 2.5 + (i % 3) * 1.8,
    speed: 0.015 + (i % 4) * 0.009,
  }));
  const particleFill = theme.isDark
    ? "rgba(255,255,255,0.18)"
    : "rgba(255,255,255,0.42)";

  const beat1End = durationSec * 0.31;
  const beat2End = durationSec * 0.65;
  const sweepSpeed = motionPreset === "Dramatic Lighting Reveal" ? 2.2 : 4.2;
  const pedestalSurfaceY = height * (isWide ? 0.78 : 0.695);
  const baseCenterY = pedestalSurfaceY - baseProdH * 0.5;

  const drawOverlaySprite = (sprite: OverlaySprite, beatProgress: number) => {
    const alpha = easeOutCubic(Math.min(1, beatProgress * 3.5));
    const slideY = (1 - easeOutCubic(Math.min(1, beatProgress * 3))) * 24;
    const dx = (width - sprite.canvas.width) * 0.5;
    const dy = sprite.yCenter - sprite.canvas.height * 0.5 + slideY;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite.canvas, dx, dy);
    ctx.globalAlpha = 1;
  };

  // Ultra-light per-frame draw: purely fast GPU texture blits (<1.5 ms on phones)
  const drawFrame = (elapsedSec: number) => {
    const t = Math.min(1, elapsedSec / durationSec);

    // 1. Pre-baked Background Layer
    if (bgImg) {
      const bgScale =
        motionPreset === "Slow Camera Push" ||
        motionPreset === "Cinematic Product Reveal"
          ? 1.02 + 0.11 * easeInOutSine(t)
          : motionPreset === "Rotating Product Display" ||
              motionPreset === "Luxury Commercial"
            ? 1.08
            : 1.02 + 0.08 * easeInOutSine(t);
      const bgPanX =
        motionPreset === "Rotating Product Display" ||
        motionPreset === "Luxury Commercial"
          ? Math.sin(elapsedSec * 0.85) * 20
          : Math.sin(elapsedSec * 0.45) * 10;
      const bw = width * bgScale;
      const bh = height * bgScale;
      ctx.drawImage(
        bgSprite,
        (width - bw) * 0.5 + bgPanX,
        (height - bh) * 0.5,
        bw,
        bh
      );
    } else {
      ctx.drawImage(bgSprite, 0, 0);
    }

    // 2. Pre-baked Lighting Sweep
    const sweepProgress = easeInOutSine((elapsedSec % sweepSpeed) / sweepSpeed);
    const sweepX = -width * 0.4 + sweepProgress * width * 1.8;
    ctx.drawImage(beamSprite, sweepX - 180, 0);

    // 3. Lightweight Ambient Dust Motes
    ctx.fillStyle = particleFill;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const py = ((p.y - elapsedSec * p.speed + 2) % 1) * height * 0.78;
      const px = p.x * width + Math.sin(elapsedSec * 1.4 + p.y * 10) * 14;
      ctx.beginPath();
      ctx.arc(px, py, p.size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Foreground Product Motion
    const enterP = easeOutCubic(elapsedSec / 0.85);
    let floatOffset = Math.sin(elapsedSec * 1.9) * 6;
    let panX = 0;
    let zoomFactor = 0.96 + 0.08 * easeOutCubic(t);
    let tiltAngle = Math.sin(elapsedSec * 1.1) * 0.012;

    if (motionPreset === "Cinematic Product Reveal") {
      zoomFactor = 0.88 + 0.18 * easeOutCubic(t);
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

    const scaleRatio = zoomFactor / peakZoom;
    const spriteW = productSprite.canvas.width * scaleRatio;
    const spriteH = productSprite.canvas.height * scaleRatio;
    const prodW = baseProdW * zoomFactor;
    const centerX = width * 0.5 + panX;
    const centerY = baseCenterY + (1 - enterP) * 85 + floatOffset;

    // 5. Pre-baked Ground Contact Shadow
    const shadowScale = Math.max(0.75, 1 - floatOffset * 0.007);
    const sw = prodW * 1.04 * shadowScale;
    const sh = 56 * shadowScale;
    ctx.drawImage(
      shadowSprite,
      centerX - sw * 0.5,
      pedestalSurfaceY + 8 - sh * 0.5,
      sw,
      sh
    );

    // 6. Pre-baked Product Cutout + Shadow Sprite
    ctx.save();
    ctx.globalAlpha = enterP;
    ctx.translate(centerX, centerY);
    if (tiltAngle !== 0) {
      ctx.rotate(tiltAngle);
    }
    ctx.drawImage(
      productSprite.canvas,
      -spriteW * 0.5,
      -spriteH * 0.5,
      spriteW,
      spriteH
    );
    ctx.restore();

    // 7. Pre-baked Kinetic Caption Cards
    if (beatSprites) {
      if (elapsedSec < beat1End) {
        drawOverlaySprite(beatSprites[0], elapsedSec / beat1End);
      } else if (elapsedSec < beat2End) {
        drawOverlaySprite(
          beatSprites[1],
          (elapsedSec - beat1End) / (beat2End - beat1End)
        );
      } else {
        drawOverlaySprite(
          beatSprites[2],
          (elapsedSec - beat2End) / (durationSec - beat2End)
        );
      }
    }

    // 8. Top Progress Hairline
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(36, 48, width - 72, 4);
    ctx.fillStyle = validAccent;
    ctx.fillRect(36, 48, (width - 72) * t, 4);
  };

  // Prime first frame so mobile hardware encoder starts cleanly with no freeze
  drawFrame(0);
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  return new Promise<GeneratedVideoResult>((resolve, reject) => {
    let rafId = 0;
    let stopGuardTimer = 0;
    let finished = false;
    let lastReportedPct = -10;

    const cleanupStreams = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      if (stopGuardTimer) window.clearTimeout(stopGuardTimer);
      for (const track of combinedStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    };

    const finishRecording = () => {
      if (finished) return;
      finished = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (stopGuardTimer) window.clearTimeout(stopGuardTimer);
      drawFrame(durationSec);
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    };

    recorder.onstop = () => {
      if (audioSource) {
        try {
          audioSource.stop();
          audioSource.disconnect();
        } catch {
          // ignore if already ended
        }
      }
      if (gainNode) {
        try {
          gainNode.disconnect();
        } catch {
          // ignore
        }
      }
      cleanupStreams();

      const cleanMime = mimeType.split(";")[0] || mimeType;
      const blob = new Blob(chunks, { type: cleanMime });
      const videoUrl = URL.createObjectURL(blob);
      onProgress?.(100);
      resolve({
        videoUrl,
        blob,
        mimeType: cleanMime,
        extension,
        durationSec,
        resolution: `${width}x${height}`,
        engine: "local_compositor",
      });
    };

    recorder.onerror = () => {
      cleanupStreams();
      reject(new Error("Video encoding failed in browser."));
    };

    // Start as a single continuous recording (avoids iOS 200ms fragment micro-stutters)
    recorder.start();
    if (audioSource) {
      audioSource.start(0);
    }

    const startTime = performance.now();

    // Safety timer guarantees completion even if user locks screen / switches tabs
    stopGuardTimer = window.setTimeout(
      finishRecording,
      Math.ceil(durationSec * 1000) + 250
    );

    // Sync canvas rendering with display vsync for silky-smooth mobile video
    const tick = (now: number) => {
      if (finished) return;
      const elapsedSec = (now - startTime) / 1000;
      if (elapsedSec >= durationSec) {
        finishRecording();
        return;
      }
      drawFrame(elapsedSec);

      // Throttle React progress updates so UI re-renders never drop video frames
      const pct = Math.min(98, Math.round((elapsedSec / durationSec) * 100));
      if (pct >= lastReportedPct + 4) {
        lastReportedPct = pct;
        onProgress?.(pct);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
  });
}