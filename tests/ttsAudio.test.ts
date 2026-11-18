import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ensurePlayableTtsAudio } from '../server/ttsAudio';

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
test('wraps Gemini PCM in a playable 24 kHz WAV', () => {
  const result = ensurePlayableTtsAudio(btoa('\x01\x02\x03\x04'), 'audio/L16;rate=24000');
  const wav = bytes(result.audioBase64);
  const view = new DataView(wav.buffer);
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), 40);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
});
test('repairs streaming WAV sizes and leaves encoded audio alone', () => {
  const wav = bytes(ensurePlayableTtsAudio(btoa('\0\0'), 'audio/pcm').audioBase64);
  const view = new DataView(wav.buffer);
  view.setUint32(4, 0xffffffff, true); view.setUint32(40, 0xffffffff, true);
  const repaired = bytes(ensurePlayableTtsAudio(btoa(String.fromCharCode(...wav)), 'audio/wav').audioBase64);
  const result = new DataView(repaired.buffer);
  assert.equal(result.getUint32(4, true), 38);
  assert.equal(result.getUint32(40, true), 2);
  assert.deepEqual(ensurePlayableTtsAudio('YWJj', 'audio/mpeg'), { audioBase64: 'YWJj', mimeType: 'audio/mpeg' });
});
test('rejects truncated PCM samples', () => {
  assert.throws(() => ensurePlayableTtsAudio('AQ==', 'audio/L16;rate=24000'));
});
