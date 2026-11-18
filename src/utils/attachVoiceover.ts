import type { GeneratedVideoResult } from '../types/studio';
import { normalizeRecordedVideoBlob } from './mp4Fixer';
import { unlockAudioContext } from './videoGenerator';

/** Re-record a generated AI video with a voiceover in the browser. */
export async function attachVoiceoverToVideo(video: GeneratedVideoResult, base64: string): Promise<GeneratedVideoResult> {
  const context = unlockAudioContext();
  if (!context) throw new Error('This browser cannot create an audio track.');
  if (context.state !== 'running') await context.resume();
  if (context.state !== 'running') throw new Error('Audio is blocked. Tap Generate again to enable audio.');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const audio = await context.decodeAudioData(bytes.buffer);
  const response = await fetch(video.videoUrl);
  if (!response.ok) throw new Error('Could not download the generated video to attach its voiceover.');
  const url = URL.createObjectURL(await response.blob());
  const element = document.createElement('video');
  element.playsInline = true;
  element.muted = true;
  element.preload = 'auto';
  element.src = url;
  let stream: MediaStream | null = null;
  let source: AudioBufferSourceNode | null = null;
  let recorder: MediaRecorder | null = null;
  let raf = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Video could not be loaded.')), 30000);
      element.onloadedmetadata = () => { window.clearTimeout(timeout); resolve(); };
      element.onerror = () => { window.clearTimeout(timeout); reject(new Error('Generated video could not be decoded.')); };
      element.load();
    });
    const duration = element.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !element.videoWidth || !element.videoHeight) throw new Error('Generated video has an invalid duration or size.');
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth; canvas.height = element.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.captureStream || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot attach voiceover to video.');
    const dest = context.createMediaStreamDestination();
    source = context.createBufferSource();
    source.buffer = audio;
    source.playbackRate.value = Math.max(1, audio.duration / Math.max(0.1, duration - 0.25));
    source.connect(dest);
    stream = canvas.captureStream(30);
    const tracks = dest.stream.getAudioTracks();
    if (!tracks.length) throw new Error('Could not create a voiceover track.');
    tracks.forEach(track => stream!.addTrack(track));
    const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('This browser cannot record video with audio.');
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    let failRecording: (error: Error) => void = () => {};
    const finished = new Promise<Blob>((resolve, reject) => {
      failRecording = reject;
      recorder!.onerror = () => reject(new Error('Could not record the AI video with voiceover.'));
      recorder!.onstop = () => chunks.length ? resolve(new Blob(chunks, { type: recorder!.mimeType || mime })) : reject(new Error('The recorded video was empty.'));
      element.onerror = () => reject(new Error('Video playback failed while attaching voiceover.'));
    });
    // Muted inline playback is required for iOS autoplay; audio is recorded separately.
    await element.play();
    ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
    recorder.start();
    source.start();
    const draw = () => {
      if (element.ended) {
        if (recorder?.state === 'recording') recorder.stop();
        return;
      }
      if (element.paused || document.hidden) {
        failRecording(new Error('Video recording was interrupted. Keep the page open and try again.'));
        return;
      }
      ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
      raf = requestAnimationFrame(draw);
    };
    element.onended = () => { if (recorder?.state === 'recording') recorder.stop(); };
    raf = requestAnimationFrame(draw);
    const recorded = await finished;
    const fixed = await normalizeRecordedVideoBlob(recorded, recorded.type, duration, 30);
    const extension = fixed.type.includes('webm') ? 'webm' : 'mp4';
    return { ...video, blob: fixed, videoUrl: URL.createObjectURL(fixed), mimeType: `video/${extension}`, extension, durationSec: duration, hasVoiceover: true };
  } finally {
    cancelAnimationFrame(raf);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    try { source?.stop(); } catch { /* already stopped */ }
    source?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    element.pause(); element.removeAttribute('src'); element.load();
    URL.revokeObjectURL(url);
  }
}
