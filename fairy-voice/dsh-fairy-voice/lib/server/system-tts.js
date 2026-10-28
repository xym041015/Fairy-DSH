/* macOS system-voice fallback: renders the same raw PCM contract as the local
 * GPT-SoVITS service (32 kHz, 16-bit, mono) so the web client streams it
 * unchanged when no local synthesis service is running. No route, settings, or
 * sentence ownership lives here. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const SAY_BIN = '/usr/bin/say';
const AFCONVERT_BIN = '/usr/bin/afconvert';
const SAMPLE_RATE = 32_000;
const CHUNK_BYTES = 64 * 1024;
const PREFERRED_VOICES = ['Tingting', 'Meijia', 'Sinji', 'Flo', 'Grandma', 'Eddy', 'Reed'];

function run(command, args, { signal, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error('system voice unavailable'), { code: 'local-service-unavailable', cause: error }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(Object.assign(new Error('system synthesis failed'), { code: 'local-service-failed' }));
    });
  });
}

export function parseVoiceList(output) {
  const voices = [];
  for (const line of String(output || '').split('\n')) {
    const match = /^(.*?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(line.trim());
    if (match) voices.push({ name: match[1].trim(), locale: match[2] });
  }
  return voices;
}

export function selectVoice(voices, override = '') {
  const preferred = String(override || '').trim();
  if (preferred) return preferred;
  for (const candidate of PREFERRED_VOICES) {
    const hit = voices.find((voice) => voice.locale === 'zh_CN' && voice.name.toLowerCase().startsWith(candidate.toLowerCase()));
    if (hit) return hit.name;
  }
  for (const locale of ['zh_CN', 'zh_TW', 'zh_HK']) {
    const hit = voices.find((voice) => voice.locale === locale);
    if (hit) return hit.name;
  }
  return voices.find((voice) => voice.locale.startsWith('zh'))?.name || '';
}

/* Only the exact client contract is accepted: mono, 16-bit, at the sample rate
 * the browser's AudioContext is constructed with. Anything else is converted. */
export function wavPcmData(buffer, sampleRate = SAMPLE_RATE) {
  if (!buffer || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    }
    if (id === 'data') {
      if (!format) return null;
      const valid = format.audioFormat === 1
        && format.channels === 1
        && format.bitsPerSample === 16
        && format.sampleRate === sampleRate;
      return valid ? buffer.subarray(body, Math.min(body + size, buffer.length)) : null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

async function* chunkIterable(pcm) {
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    yield pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
  }
}

export function createSystemTtsTransport({
  runCommand = run,
  voiceOverride = process.env.DSH_FAIRY_TTS_VOICE || '',
  speechRate = process.env.DSH_FAIRY_TTS_RATE || '',
  sampleRate = SAMPLE_RATE,
  temporaryRoot = tmpdir(),
} = {}) {
  let resolvedVoice = null;
  const resolveVoice = async (signal) => {
    if (resolvedVoice !== null) return resolvedVoice;
    const list = await runCommand(SAY_BIN, ['-v', '?'], { signal });
    resolvedVoice = selectVoice(parseVoiceList(typeof list === 'string' ? list : ''), voiceOverride);
    return resolvedVoice;
  };
  return {
    async status(signal) {
      const voice = await resolveVoice(signal);
      return { available: true, reason: null, backend: 'system-voice', voice: voice || null };
    },
    async stream(text, signal) {
      const voice = await resolveVoice(signal);
      const directory = await mkdtemp(join(temporaryRoot, 'dsh-fairy-voice-'));
      const release = () => { void rm(directory, { recursive: true, force: true }).catch(() => {}); };
      try {
        const audioPath = join(directory, 'speech.wav');
        await runCommand(SAY_BIN, [
          ...(voice ? ['-v', voice] : []),
          ...(speechRate ? ['-r', String(speechRate)] : []),
          '-o', audioPath,
          `--data-format=LEI16@${sampleRate}`,
          text,
        ], { signal });
        let pcm = wavPcmData(await readFile(audioPath), sampleRate);
        if (!pcm) {
          const convertedPath = join(directory, 'speech-converted.wav');
          await runCommand(AFCONVERT_BIN, ['-f', 'WAVE', '-d', `LEI16@${sampleRate}`, '-c', '1', audioPath, convertedPath], { signal });
          pcm = wavPcmData(await readFile(convertedPath), sampleRate);
        }
        if (!pcm || !pcm.length) throw Object.assign(new Error('system synthesis produced no audio'), { code: 'local-service-failed' });
        const body = Readable.from(chunkIterable(pcm));
        if (signal) {
          if (signal.aborted) body.destroy();
          else signal.addEventListener('abort', () => body.destroy(), { once: true });
        }
        return {
          response: { ok: true, headers: { get: () => 'audio/raw' }, body },
          release,
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
