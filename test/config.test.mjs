import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readReproConfig, browserConfig, sdkPaths, traceInclude } from '../src/repro-config.mjs';

const valid = {
  REPRO_ENABLED: 'true', REPRO_TENANT_ID: 'test-tenant', REPRO_APP_ID: 'test-app',
  REPRO_APP_SECRET: 'test-server-secret-not-for-browser', REPRO_CAPTURE_MODE: 'staging',
  REPRO_API_BASE_URL: 'http://127.0.0.1:4000/api', REPRO_LOG_COLLECTOR_URL: 'http://localhost:8080',
  REPRO_VIEWER_BASE_URL: 'http://localhost:5173/viewer',
};

test('baseline needs no SDK or account; enabled capture rejects incomplete config before starting', async () => {
  assert.equal(await readReproConfig({}), null);
  assert.equal(await readReproConfig({ REPRO_ENABLED: 'false', REPRO_CAPTURE_MODE: 'invalid' }), null);
  assert.deepEqual(browserConfig(null), { enabled: false });
  await assert.rejects(readReproConfig({ REPRO_ENABLED: 'true' }), /requires appId/);
  await assert.rejects(readReproConfig({ REPRO_ENABLED: 'typo' }), /true or false/);
  assert.throws(() => sdkPaths(() => { throw new Error('missing package'); }), /YOM feature SDK builds/);
  assert.throws(() => sdkPaths(() => fileURLToPath(import.meta.url)), /YOM feature SDK builds/);
});

test('browser configuration is an explicit allowlist and preserves live sampling zero', async () => {
  const config = await readReproConfig({ ...valid, REPRO_CAPTURE_MODE: 'live', REPRO_SAMPLE_RATE: '0', REPRO_CAPTURE_RAW: 'false' });
  assert.equal(config.captureRaw, false);
  const browser = browserConfig({ ...config, internalOnly: 'also-private' });
  assert.deepEqual(Object.keys(browser.options).sort(), ['apiBase', 'appId', 'ingest', 'tenantId', 'viewerBase']);
  assert.equal(browser.options.ingest.liveCapture.sampleRate, 0);
  assert.equal(browser.options.ingest.mode, 'live');
  assert(!JSON.stringify(browser).includes(valid.REPRO_APP_SECRET));
  assert(!JSON.stringify(browser).includes('also-private'));
});

test('unsafe URLs, invalid modes and invalid sampling fail without disclosing secrets', async () => {
  for (const key of ['REPRO_API_BASE_URL', 'REPRO_LOG_COLLECTOR_URL', 'REPRO_VIEWER_BASE_URL', 'REPRO_MEDIA_API_BASE_URL']) {
    for (const url of ['ftp://remote.example', 'http://remote.example', 'https://user:private-password@remote.example', 'not a URL']) {
      await assert.rejects(readReproConfig({ ...valid, REPRO_MEDIA_ENABLED: 'true', [key]: url }), error => {
        assert.match(error.message, /Invalid/);
        assert(!error.message.includes('private-password'));
        return true;
      });
    }
  }
  for (const sample of ['NaN', '-1', '1.1', 'Infinity']) {
    await assert.rejects(readReproConfig({ ...valid, REPRO_SAMPLE_RATE: sample }), /between 0 and 1/);
  }
  await assert.rejects(readReproConfig({ ...valid, REPRO_CAPTURE_MODE: 'typo' }), /live or staging/);
  await assert.rejects(readReproConfig({ ...valid, REPRO_MEDIA_ENABLED: 'yes' }), /true or false/);
  await assert.rejects(readReproConfig({ ...valid, REPRO_CAPTURE_RAW: 'yes' }), /true or false/);
});

test('media is opt-in and supports the same API or an explicit media-capable API', async () => {
  assert.equal((await readReproConfig(valid)).mediaApiBase, undefined);
  assert.equal((await readReproConfig({ ...valid, REPRO_MEDIA_ENABLED: 'true' })).mediaApiBase, valid.REPRO_API_BASE_URL);
  assert.equal((await readReproConfig({ ...valid, REPRO_MEDIA_ENABLED: 'true', REPRO_MEDIA_API_BASE_URL: 'https://media.example/api' })).mediaApiBase, 'https://media.example/api');
  assert.equal((await readReproConfig({ ...valid, REPRO_MEDIA_ENABLED: 'false', REPRO_MEDIA_API_BASE_URL: 'ignored' })).mediaApiBase, undefined);
});

test('trace filter includes this standalone app, not sibling apps or dependencies', () => {
  for (const name of ['src/agent.mjs', 'src/domain.mjs', 'azure/streaming.mjs', 'azure/capacity.cjs']) {
    assert(traceInclude.test(fileURLToPath(new URL('../' + name, import.meta.url))), name);
  }
  for (const name of ['node_modules/pg/index.js', 'test/config.test.mjs', '../other/src/agent.mjs']) {
    assert(!traceInclude.test(fileURLToPath(new URL('../' + name, import.meta.url))), name);
  }
});

test('application Node imports resolve within the exported repository', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const directory of ['src', 'azure', 'scripts']) {
    for (const file of await readdir(new URL('../' + directory, import.meta.url))) {
      if (!/\.[cm]js$/.test(file)) continue;
      const url = new URL('../' + directory + '/' + file, import.meta.url);
      const code = await readFile(url, 'utf8');
      for (const match of code.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])(\.[^'"]+)\1/g)) {
        const target = new URL(match[2], url);
        assert(fileURLToPath(target).startsWith(root), file + ' imports outside the app');
        await readFile(target);
      }
    }
  }
});
