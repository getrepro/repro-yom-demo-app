import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import { chromium } from 'playwright';
import { sdkPaths } from '../src/repro-config.mjs';
import { waitFor } from '../scripts/azure-local.mjs';

// Real installed SDKs and application; only Repro admission/ingest is stubbed.
// This does not certify remote persistence, media storage, accounting or viewer completion.
test('installed SDKs correlate browser, iframe, Functions, polling job and database evidence', { timeout: 360000 }, async () => {
  sdkPaths();
  const db = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'capture-test', POSTGRES_DB: 'capture_test' })
    .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2)).start();
  const events = [], sessions = [], claims = [];
  let server, child, browser, logs = '';
  try {
    server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://capture');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      let output = {};
      if (url.pathname.endsWith('/bootstrap')) output = { enabled: true, sdkToken: 'synthetic-sdk-token' };
      else if (url.pathname.endsWith('/privacy-policy')) output = { enabled: false };
      else if (url.pathname.endsWith('/live-sessions/claim')) {
        claims.push(body);
        output = { captured: true, childSessionId: 'S_worker_test', actionId: 'A_worker_test' };
      } else if (url.pathname === '/api/v1/sessions') {
        sessions.push(body); output = { sessionId: body.sessionId, clockOffsetMs: 0 };
      } else if (url.pathname.endsWith('/ingest/events')) {
        events.push(...(body.events ?? [])); output = { accepted: body.events?.length ?? 0 };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(output));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    child = spawn(process.execPath, ['src/bootstrap.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, REPRO_ENABLED: 'true', REPRO_TENANT_ID: 'TENANT_local_test', REPRO_APP_ID: 'APP_local_test',
        REPRO_APP_SECRET: 'synthetic-test-secret', REPRO_API_BASE_URL: base + '/api', REPRO_LOG_COLLECTOR_URL: base,
        REPRO_VIEWER_BASE_URL: base + '/viewer', REPRO_CAPTURE_MODE: 'live', REPRO_SAMPLE_RATE: '1',
        REPRO_CAPTURE_RAW: 'true', REPRO_MEDIA_ENABLED: 'false', REPRO_PRIVACY_ENVIRONMENT: 'yom-poc',
        YOM_APP_PORT: '0', YOM_PLAYER_PORT: '0',
        YOM_DEMO_DATABASE_URL: 'postgresql://postgres:capture-test@' + db.getHost() + ':' + db.getMappedPort(5432) + '/capture_test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = data => { logs = (logs + data.toString()).slice(-16000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const appOrigin = await waitFor(() => {
      if (child.exitCode !== null) throw new Error('App exited: ' + logs);
      return logs.match(/Circuit streaming app: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    }, 'capture-enabled app startup', 180000);
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    await page.goto(appOrigin);
    await page.waitForFunction(() => window.repro?.snapshot().recording);
    const safe = await (await fetch(appOrigin + '/api/repro-config')).json();
    assert(!JSON.stringify(safe).includes('synthetic-test-secret'));
    await page.selectOption('#game', 'circuit');
    await page.selectOption('#scenario', 'billing');
    await page.click('#launch');
    await page.waitForSelector('#player-container iframe', { timeout: 70000 });
    const frame = await (await page.$('#player-container iframe')).contentFrame();
    await frame.waitForFunction(() => window.playerStats.presented > 10, null, { timeout: 20000 });
    await frame.waitForFunction(() => window.reproFrame?.snapshot().recording);
    await frame.click('button[aria-label="Accelerate"]');
    await frame.waitForFunction(() => window.playerStats.inputAcknowledged >= 2);
    await page.waitForTimeout(5500);
    const sid = await page.evaluate(() => repro.snapshot().sessionId);
    await page.click('#end');
    await page.waitForFunction(() => !document.querySelector('#launch').disabled);
    assert.match(await page.locator('#receipt').innerText(), /above your contracted rate/);
    await page.evaluate(() => repro.stop());
    await page.waitForFunction(() => !document.querySelector('#player-container iframe'), null, { timeout: 70000 });

    const correlated = () => events.filter(event => event.session_id === sid);
    const requests = () => correlated().filter(event => event.event_type === 'backend_request');
    const traces = () => correlated().filter(event => event.event_type === 'trace_batch').flatMap(event => event.payload?.trace ?? []);
    const requiredCalls = ['validateLaunch', 'settleSession', 'allocateStream'];
    const complete = () => ['launchStream', 'finishStream'].every(name =>
      requests().some(event => event.payload?.request?.url === 'azure-function://' + name))
      && requiredCalls.every(name => ['enter', 'exit'].every(type => traces().some(trace => trace.fn === name && trace.type === type)))
      && ['frontend_action', 'rrweb_chunk', 'session_capture_manifest', 'db_change'].every(type => correlated().some(event => event.event_type === type));
    await waitFor(complete, 'correlated capture delivery', 120000);
    const launch = requests().find(event => event.payload.request.url === 'azure-function://launchStream');
    const worker = requests().find(event => event.payload.request.method === 'WORKER');
    assert(worker, 'a dispatched job must retain the browser session');
    assert.equal(worker.payload.request.headers['x-repro-request-rid'], launch.payload.request.rid);
    assert(requests().every(event => ['AZURE_FUNCTION', 'WORKER'].includes(event.payload.request.method)));
    assert(correlated().some(event => event.event_type === 'db_change' && JSON.stringify(event.payload).includes('streaming_sessions')));
    const actions = correlated().filter(event => event.event_type === 'frontend_action');
    assert(actions.some(event => JSON.stringify(event.payload).includes('Accelerate')), 'owned iframe actions must be captured');
    assert(actions.some(event => JSON.stringify(event.payload).includes('framesDecoded')), 'WebRTC statistics must be captured');
    const network = actions.map(event => event.payload?.ui?.network).filter(value => value?.protocol === 'websocket');
    const open = network.find(value => value.event === 'open');
    assert(open, 'Socket.IO must use the instrumented WebSocket');
    assert(network.some(value => value.event === 'close' && value.connectionId === open.connectionId && Number.isInteger(value.metrics.code)));
    assert(sessions.some(session => session.sessionKind === 'child'));
    assert.equal(claims.length, 0, 'correlated jobs and empty polls must not claim another recording');
    console.log('Verified correlated browser, iframe, Functions, worker, ESM enter/exit traces, PostgreSQL, WebRTC and WebSocket evidence.');
  } catch (error) {
    console.error('Local capture fixture output:', logs);
    throw error;
  } finally {
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 45000);
      try { await exited; } finally { clearTimeout(killer); }
    }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.stop();
  }
});
