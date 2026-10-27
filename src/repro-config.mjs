import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
export const traceInclude = new RegExp(root.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&') + '(src|azure)/');

function boolean(env, key, fallback = false) {
  const value = env[key];
  if (!value) return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(key + ' must be true or false.');
  return value === 'true';
}

export async function readReproConfig(env = process.env) {
  if (!boolean(env, 'REPRO_ENABLED')) return null;
  const config = {
    tenantId: env.REPRO_TENANT_ID, appId: env.REPRO_APP_ID, appSecret: env.REPRO_APP_SECRET,
    apiBase: env.REPRO_API_BASE_URL, ingestBase: env.REPRO_LOG_COLLECTOR_URL,
    viewerBase: env.REPRO_VIEWER_BASE_URL, mode: env.REPRO_CAPTURE_MODE || 'staging',
    sampleRate: Number(env.REPRO_SAMPLE_RATE ?? 1),
    captureRaw: boolean(env, 'REPRO_CAPTURE_RAW', true),
    environment: env.REPRO_PRIVACY_ENVIRONMENT || 'yom-poc',
    mediaApiBase: boolean(env, 'REPRO_MEDIA_ENABLED') ? (env.REPRO_MEDIA_API_BASE_URL || env.REPRO_API_BASE_URL) : undefined,
  };
  for (const key of ['appId', 'tenantId', 'appSecret', 'apiBase', 'ingestBase', 'viewerBase']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error('Repro config requires ' + key + '; see .env.example.');
  }
  for (const key of ['apiBase', 'ingestBase', 'viewerBase', 'mediaApiBase']) {
    if (!config[key]) continue;
    let url;
    try { url = new URL(config[key]); } catch { throw new Error('Invalid ' + key + ': expected an absolute URL.'); }
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Invalid ' + key + ': use HTTPS (or local HTTP) without URL credentials.');
    }
  }
  if (!['live', 'staging'].includes(config.mode)) throw new Error('REPRO_CAPTURE_MODE must be live or staging.');
  if (!Number.isFinite(config.sampleRate) || config.sampleRate < 0 || config.sampleRate > 1) {
    throw new Error('REPRO_SAMPLE_RATE must be between 0 and 1.');
  }
  return config;
}

export function browserConfig(config) {
  if (!config) return { enabled: false };
  // Explicit allowlist: never send the service secret or policy options to browsers.
  return { enabled: true, options: { tenantId: config.tenantId, appId: config.appId, apiBase: config.apiBase,
    viewerBase: config.viewerBase,
    ingest: { mode: config.mode, baseUrl: config.ingestBase, actorId: 'yom-synthetic-player', actorType: 'user',
      actorLabels: { env: 'yom-poc', platform: 'browser' }, liveCapture: { sampleRate: config.sampleRate },
      requestContextPropagation: 'auto' } } };
}

export function sdkPaths(resolve = specifier => require.resolve(specifier)) {
  try {
    const nodeDist = dirname(resolve('@reproapp/node-sdk'));
    const browserBundle = join(dirname(resolve('@reproapp/react-sdk')), 'browser.global.js');
    if (![browserBundle, join(nodeDist, 'integrations/automatic-execution.js'), join(nodeDist, 'integrations/job-transport.js')].every(existsSync)) throw new Error('Missing YOM feature files');
    return { browserBundle };
  } catch {
    throw new Error('Repro capture requires both YOM feature SDK builds. Install the packages supplied by Repro; see README. Set REPRO_ENABLED=false to run without capture.');
  }
}

export async function initializeBackendCapture(config) {
  if (!config) return;
  const { initRepro } = await import('@reproapp/node-sdk');
  await initRepro({ appId: config.appId, tenantId: config.tenantId, appSecret: config.appSecret,
    appName: 'yom-polling-agent', serviceName: 'YOM Polling Agent',
    apiBase: config.apiBase, ingestBase: config.ingestBase,
    privacy: { apiBase: config.apiBase, environment: config.environment, captureRaw: config.captureRaw },
    tracing: { include: [traceInclude], disableFunctionTypes: ['constructor'], logFunctionCalls: false },
    actorId: 'yom-synthetic-worker', actorType: 'worker',
    liveMode: { enabled: config.mode === 'live', liveCapture: { sampleRate: config.sampleRate } },
  });
}
