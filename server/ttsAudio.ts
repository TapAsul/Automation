/** Convert Gemini's signed 16-bit little-endian PCM to browser-playable WAV. */
export function ensurePlayableTtsAudio(base64: string, mimeType: string): { audioBase64: string; mimeType: string } {
  const binary = atob(base64);
  const input = Uint8Array.from(binary, c => c.charCodeAt(0));
  const ascii = (at: number, text: string) => [...text].every((c, i) => input[at + i] === c.charCodeAt(0));
  if (input.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WAVE')) {
    const view = new DataView(input.buffer);
    if (view.getUint32(4, true) === 0xffffffff) view.setUint32(4, input.length - 8, true);
    for (let offset = 12; offset + 8 <= input.length;) {
      const size = view.getUint32(offset + 4, true);
      if (ascii(offset, 'data') && (size === 0xffffffff || size > input.length - offset - 8)) {
        view.setUint32(offset + 4, input.length - offset - 8, true);
        break;
      }
      if (size > input.length - offset - 8) break;
      offset += 8 + size + (size & 1);
    }
    return { audioBase64: toBase64(input), mimeType: 'audio/wav' };
  }
  if (!/^audio\/(?:l16|pcm|x-pcm)(?:\s*;|$)/i.test(mimeType)) return { audioBase64: base64, mimeType };
  const rate = Number(/(?:rate|samplerate)\s*=\s*(\d+)/i.exec(mimeType)?.[1] || 24000);
  const channels = Number(/channels\s*=\s*(\d+)/i.exec(mimeType)?.[1] || 1);
  if (rate < 8000 || rate > 192000 || channels < 1 || channels > 2 || input.length % (2 * channels)) throw new Error('Invalid PCM voiceover format.');
  const wav = new Uint8Array(44 + input.length);
  const view = new DataView(wav.buffer);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => { wav[offset + i] = c.charCodeAt(0); });
  write(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, input.length, true); wav.set(input, 44);
  return { audioBase64: toBase64(wav), mimeType: 'audio/wav' };
}
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
