import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import {
  FAIRY_IDENTITY_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_VERSION,
} from 'dsh-fairy-contracts';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

const FAIRY_VISUAL_SETTINGS = FAIRY_VISUAL_SETTINGS_NAMESPACE;
const FAIRY_IDENTITY_SETTINGS = FAIRY_IDENTITY_SETTINGS_NAMESPACE;
const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

export const FairyVisualSettings = z.object({
  version: z.number().step(1).default(FAIRY_VISUAL_SETTINGS_VERSION),
  enabled: z.boolean().default(false),
  theme: z.union(['dark', 'light']).default('dark'),
  mascotVisible: z.boolean().default(true),
  mascotScale: z.number().step(0.01).min(0.55).max(1).default(1),
  mascotAnimationSpeed: z.union([z.const(0.7), z.const(1), z.const(1.5)]).default(1),
  powerMode: z.union(['normal', 'low-power']).default('normal'),
  composerDockHeight: z.number().step(1).min(132).max(420).default(132),
});

export const FairyIdentitySettings = z.object({
  mode: z.union(['ling', 'zhe', 'custom']).default('ling'),
  customName: z.string().default(''),
  secondAssistant: z.string().default(''),
  household: z.array(z.string()).default([]),
});

export const name = 'dsh-fairy-visual';

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    ctx.inject(['webServer'], (ws) => ws.effect(() => {
      const unregisterSettings = ws.webServer.register({ kind: 'exact', path: '/fairy-visual/settings', handler: settingsHandler });
      return () => unregisterSettings();
    }));
  }, { surface: 'host' });
}

function readJsonBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 'payload-too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'invalid-json' }));
      }
    });
    req.on('error', reject);
  });
}

const __fairyTest = { loadSettingsStore, writeSettingsStore, parseLegacyBlock };
export { __fairyTest };

function settingsHandler(req, res) {
  try {
    if (req.method === 'GET') {
      const store = loadSettingsStore();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(store));
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req).then((body) => {
        const store = loadSettingsStore();
        if (body.visual && typeof body.visual === 'object') store.visual = { ...store.visual, ...body.visual };
        if (body.identity && typeof body.identity === 'object') store.identity = { ...store.identity, ...body.identity };
        writeSettingsStore(store);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(store));
      }).catch((error) => {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.code || 'settings-write-failed' }));
      });
      return;
    }
    res.statusCode = 405;
    res.end();
  } catch (error) {
    diagnostics.error?.('settings.route', error, {});
    res.statusCode = 500;
    res.end();
  }
}

/* 0.2.0 起 settingsScope/webUiSettings 被移除,套件设置改由插件自有存储承载:
 * ~/.dsh(/DSH_HOME)/fairy-visual/settings.json,经 webServer 路由读写。 */

function fairyVisualHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function settingsStorePath() {
  return join(fairyVisualHome(), 'fairy-visual', 'settings.json');
}

function parseLegacyBlock(source, key) {
  const lines = String(source || '').split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return {};
  const block = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;
    const [, name, raw] = match;
    let value = raw;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) value = Number(raw);
    else if (/^\[.*\]$/.test(raw)) value = raw.slice(1, -1).split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    else if (typeof value === 'string') value = value.replace(/^['"]|['"]$/g, '');
    block[name] = value;
  }
  return block;
}

function loadLegacySeed() {
  for (const candidate of [join(fairyVisualHome(), 'settings.yaml.imported'), join(fairyVisualHome(), 'settings.yaml')]) {
    try {
      const source = readFileSync(candidate, 'utf8');
      const visual = parseLegacyBlock(source, 'fairy-visual');
      const identity = parseLegacyBlock(source, 'fairy-identity');
      if (Object.keys(visual).length || Object.keys(identity).length) return { visual, identity };
    } catch {
      /* legacy settings absent; fall through to defaults */
    }
  }
  return { visual: {}, identity: {} };
}

function loadSettingsStore() {
  try {
    const parsed = JSON.parse(readFileSync(settingsStorePath(), 'utf8'));
    return {
      visual: parsed.visual || {},
      identity: parsed.identity || {},
    };
  } catch {
    const seeded = loadLegacySeed();
    writeSettingsStore(seeded);
    return seeded;
  }
}

function writeSettingsStore(store) {
  const target = settingsStorePath();
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}
