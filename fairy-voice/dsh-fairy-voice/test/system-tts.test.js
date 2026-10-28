import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSystemTtsTransport, parseVoiceList, selectVoice, wavPcmData } from '../lib/server/system-tts.js';

const VOICE_LIST = [
  'Tingting (中文（中国大陆）) zh_CN    # 你好！我叫婷婷。',
  'Meijia              zh_TW    # 你好，我叫美佳。',
  'Daniel              en_GB    # Hello, my name is Daniel.',
].join('\n');

function wavBuffer({ channels = 1, sampleRate = 32000, bits = 16, samples = 8 } = {}) {
  const data = Buffer.alloc(samples * channels * (bits / 8), 1);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('selects a Chinese system voice and honours an explicit override', () => {
  const voices = parseVoiceList(VOICE_LIST);
  assert.deepEqual(voices.map((voice) => voice.locale), ['zh_CN', 'zh_TW', 'en_GB']);
  assert.equal(selectVoice(voices), 'Tingting (中文（中国大陆）)');
  assert.equal(selectVoice(voices, 'Meijia'), 'Meijia');
});

test('accepts only the 32 kHz mono 16-bit PCM contract', () => {
  assert.equal(wavPcmData(wavBuffer()).length, 16);
  assert.equal(wavPcmData(wavBuffer({ channels: 2 })), null);
  assert.equal(wavPcmData(wavBuffer({ sampleRate: 44100 })), null);
  assert.equal(wavPcmData(Buffer.from('not a wav')), null);
});

test('streams raw PCM and converts an unsupported system render', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fairy-voice-test-'));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === '-v' && args[1] === '?') return VOICE_LIST;
    const target = args.indexOf('-o') >= 0 ? args[args.indexOf('-o') + 1] : args[args.length - 1];
    await writeFile(target, command.endsWith('afconvert') ? wavBuffer() : wavBuffer({ channels: 2 }));
    return '';
  };
  try {
    const transport = createSystemTtsTransport({ runCommand, temporaryRoot: root });
    const status = await transport.status();
    assert.equal(status.available, true);
    assert.equal(status.backend, 'system-voice');
    assert.equal(status.voice, 'Tingting (中文（中国大陆）)');
    const upstream = await transport.stream('测试', undefined);
    const chunks = [];
    for await (const chunk of upstream.response.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, 16);
    assert.ok(calls.some(([command]) => command.endsWith('afconvert')));
    upstream.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
