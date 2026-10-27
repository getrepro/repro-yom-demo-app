import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { GenericContainer, Wait } from 'testcontainers';
import { chromium } from 'playwright';
import { createStore } from '../src/store.mjs';
import { startServers } from '../src/server.mjs';
import { forkAgent } from '../src/fork-agent.mjs';
import { validateLaunch } from '../src/domain.mjs';

// App tests must never send synthetic traffic to an inherited remote account.
process.env.REPRO_ENABLED = 'false';

test('real Azure backend, PostgreSQL queue, separate polling worker, cross-origin WebRTC and fault scenarios', { timeout: 300_000 }, async t => {
  const database = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'poc-test', POSTGRES_DB: 'yom_test' })
    .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2)).start();
  let store, servers, agent, browser;
  try {
    store = await createStore(`postgresql://postgres:poc-test@${database.getHost()}:${database.getMappedPort(5432)}/yom_test`);
    await t.test('overlapping polls claim each job once; stale leases cannot start cancelled sessions', async () => {
      const jobs = await Promise.all(Array.from({ length: 8 }, () => store.launch(validateLaunch({ gameId: 'circuit', quality: 'high', scenario: 'normal' }))));
      const claims = await Promise.all(Array.from({ length: 16 }, () => store.claim()));
      assert.equal(claims.filter(Boolean).length, 8);
      assert.equal(new Set(claims.filter(Boolean).map(row => row.id)).size, 8);
      for (const job of jobs) await store.finish(job.id);
      const claimed = claims.find(Boolean);
      assert.equal(await store.started(claimed.id, claimed.lease_token, 'high'), null);
      await store.pool.query('DELETE FROM streaming_sessions');
    });
    const agentKey = 'isolated-local-container-test-agent';
    servers = await startServers({ store, agentKey, disconnectGraceMs: 1500 });
    agent = await forkAgent({ ...servers, agentKey, pollMs: 100 });
    assert.notEqual(agent.pid, process.pid, 'agent must run independently with no HTTP server');
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    // Emulate a player whose network cannot resolve the host's mDNS candidates.
    // Do not replace the media transport: numeric candidates still use real ICE.
    await page.addInitScript(() => {
      const NativePeer = RTCPeerConnection;
      window.remoteCandidateKinds = [];
      const mdns = line => line.startsWith('a=candidate:') && /\.local\s/.test(line);
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) {
          super(...args);
          this.addEventListener('icecandidate', event => {
            if (/\.local\s/.test(event.candidate?.candidate ?? '')) event.stopImmediatePropagation();
          });
        }
        get localDescription() {
          const description = super.localDescription;
          return description && { type: description.type, sdp: description.sdp.split('\r\n').filter(line => !mdns(line)).join('\r\n') };
        }
        setRemoteDescription(description) {
          const lines = description.sdp.split('\r\n');
          for (const line of lines.filter(line => line.startsWith('a=candidate:'))) {
            window.remoteCandidateKinds.push(mdns(line) ? 'mdns' : 'numeric');
          }
          return super.setRemoteDescription({ ...description, sdp: lines.filter(line => !mdns(line)).join('\r\n') });
        }
        addIceCandidate(candidate) {
          if (candidate?.candidate) {
            const unresolved = /\.local\s/.test(candidate.candidate);
            window.remoteCandidateKinds.push(unresolved ? 'mdns' : 'numeric');
            if (unresolved) return Promise.resolve();
          }
          return super.addIceCandidate(candidate);
        }
      };
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(servers.appOrigin);
    await page.waitForSelector('#scenario option', { state: 'attached' });
    await page.selectOption('#game', 'circuit');
    await page.screenshot({ path: new URL('../artifacts/library-desktop.png', import.meta.url).pathname, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: new URL('../artifacts/library-mobile.png', import.meta.url).pathname, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile must not overflow');
    await page.setViewportSize({ width: 1440, height: 1050 });
    let current;
    async function launch(scenario, { waitForFrames = true } = {}) {
      await page.selectOption('#scenario', scenario);
      const response = page.waitForResponse(response => response.url().endsWith('/api/launch') && response.request().method() === 'POST');
      await page.click('#launch');
      const launched = await response;
      assert.equal(launched.headers()['x-yom-backend'], 'azure-functions');
      current = await launched.json();
      if (['allocation', 'capacity-unavailable'].includes(scenario)) return null;
      await page.waitForSelector('#player-container iframe', { timeout: 25_000 });
      const frame = await (await page.$('#player-container iframe')).contentFrame();
      assert.notEqual(new URL(frame.url()).origin, servers.appOrigin, 'player must be cross-origin');
      if (!waitForFrames) return frame;
      try { await frame.waitForFunction(() => window.playerStats?.presented > 15, null, { timeout: 15_000 }); }
      catch (error) {
        console.error('Player diagnostics:', await frame.evaluate(() => ({ stats: window.playerStats, ready: document.querySelector('video').readyState })));
        throw error;
      }
      return frame;
    }
    async function end() {
      await page.click('#end');
      await page.waitForFunction(() => !document.querySelector('#launch').disabled);
      return store.get(current.id);
    }
    let baselinePassed = false;
    await t.test('without player mDNS resolution, real frames and controls work and finish is idempotent', async () => {
      const frame = await launch('normal');
      assert((await frame.evaluate(() => window.remoteCandidateKinds)).includes('numeric'), 'host must offer a usable numeric candidate');
      await frame.waitForFunction(() => document.querySelector('video').videoHeight === 720, null, { timeout: 10_000 });
      const before = await frame.evaluate(() => ({ ...window.playerStats }));
      assert.equal(before.height, 720);
      await frame.click('button[aria-label="Accelerate"]');
      await frame.waitForFunction(() => window.playerStats.inputAcknowledged >= 2);
      await frame.waitForFunction(count => window.playerStats.presented > count + 10, before.presented);
      const pixels = await frame.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 36;
        const g = c.getContext('2d'); g.drawImage(document.querySelector('video'), 0, 0, 64, 36);
        const bytes = g.getImageData(0, 0, 64, 36).data;
        return new Set(Array.from(bytes).filter((_, i) => i % 4 !== 3)).size;
      });
      assert(pixels > 30, 'video must show the game, not a blank canvas');
      // RTC acknowledgement means applied by the game; PostgreSQL evidence is
      // delivered separately over signaling and may still be in flight.
      const persistedBy = Date.now() + 5000;
      while (((await store.get(current.id)).last_input?.sequence ?? 0) < 2 && Date.now() < persistedBy) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert((await store.get(current.id)).last_input?.sequence >= 2, 'input evidence must reach PostgreSQL');
      await page.screenshot({ path: new URL('../artifacts/stream-desktop.png', import.meta.url).pathname, fullPage: true });
      const receipt = await end();
      assert.equal(receipt.settlement.chargedCents, receipt.settlement.contractCents);
      const repeated = await Promise.all(Array.from({ length: 8 }, () => store.finish(current.id)));
      repeated.forEach(row => assert.deepEqual(row.settlement, receipt.settlement));
      baselinePassed = true;
    });
    assert(baselinePassed, 'stop fault scenarios when the baseline stream fails');
    await t.test('allocation failure produces no charge and restores launch controls', async () => {
      await launch('allocation');
      await page.waitForFunction(() => document.querySelector('#message').textContent.includes('No streaming capacity'));
      const row = await store.get(current.id);
      assert.equal(row.state, 'failed'); assert.equal(row.started_at, null); assert.equal(row.settlement, null);
    });
    await t.test('quality mismatch exists in the actual video, not only displayed metadata', async () => {
      const frame = await launch('quality');
      await frame.waitForFunction(() => document.querySelector('video').videoHeight === 540, null, { timeout: 10_000 });
      assert.equal(await frame.evaluate(() => document.querySelector('video').videoHeight), 540);
      const row = await store.get(current.id);
      assert.equal(row.requested_quality, 'high'); assert.equal(row.actual_quality, 'standard');
      await end();
    });
    await t.test('capacity retry recovers the same allocation after one transient 503', async () => {
      await launch('capacity-retry');
      const capacity = (await store.pool.query('SELECT attempts, accepted FROM azure_capacity WHERE job_id=$1', [current.id])).rows[0];
      assert.equal(capacity.attempts, 2);
      assert.equal(capacity.accepted, true);
      const row = await end();
      assert.equal(row.settlement.chargedCents, row.settlement.contractCents);
    });
    await t.test('exhausted capacity retries fail without starting a game or charging', async () => {
      await launch('capacity-unavailable');
      await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Capacity service is unavailable'));
      const row = await store.get(current.id);
      assert.equal(row.state, 'failed');
      assert.equal(row.started_at, null);
      assert.equal(row.settlement, null);
      const capacity = (await store.pool.query('SELECT attempts FROM azure_capacity WHERE job_id=$1', [current.id])).rows[0];
      assert.equal(capacity.attempts, 3);
    });
    await t.test('silent billing error succeeds but violates the contracted rate', async () => {
      await launch('billing'); const row = await end();
      assert.equal(row.state, 'ended'); assert.equal(row.settlement.appliedRate, 30);
      assert.equal(row.settlement.chargedCents - row.settlement.contractCents, row.settlement.billedMinutes * 10);
      await page.waitForSelector('.receipt-alert');
    });
    await t.test('input delay is observable before an acknowledgement, not a disconnected channel', async () => {
      const frame = await launch('delayed-controls');
      const started = Date.now();
      await frame.click('button[aria-label="Accelerate"]');
      await frame.waitForFunction(() => window.playerStats.inputAcknowledged >= 2);
      assert(Date.now() - started >= 700);
      await end();
    });
    await t.test('presentation stall stops displayed frames while inbound bytes continue', async () => {
      const frame = await launch('presentation-stall');
      await frame.waitForFunction(() => document.querySelector('video').paused, { timeout: 15_000 });
      await frame.waitForTimeout(1500);
      const before = await frame.evaluate(() => ({ ...window.playerStats }));
      await frame.waitForTimeout(2200);
      const after = await frame.evaluate(() => ({ ...window.playerStats }));
      assert.equal(after.presented, before.presented);
      assert(after.bytes > before.bytes, 'receiver is still receiving while playback is paused');
      await end();
    });
    await t.test('source freeze stops rendering without ending the business session', async () => {
      const frame = await launch('source-freeze');
      await frame.waitForFunction(() => document.querySelector('#status').textContent === 'Stream interrupted', { timeout: 16_000 });
      const before = await frame.evaluate(() => window.playerStats.presented);
      await frame.waitForTimeout(1500);
      assert.equal(await frame.evaluate(() => window.playerStats.presented), before);
      assert.equal((await store.get(current.id)).state, 'streaming');
      await end();
    });
    await t.test('an abandoned player releases its game host and settles once, then another launch works', async () => {
      await launch('normal');
      const abandonedId = current.id;
      const playerToken = current.playerToken;
      await page.goto('about:blank');
      let ended;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        ended = await store.get(abandonedId);
        if (ended.state === 'ended') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(ended.state, 'ended', 'disconnected players must not keep an allocated game host indefinitely');
      assert(ended.settlement);
      const response = await fetch(`${servers.appOrigin}/api/sessions/${abandonedId}/finish`, {
        method: 'POST', headers: { authorization: `Bearer ${playerToken}` },
      });
      assert.equal(response.status, 200);
      const again = await response.json();
      assert.deepEqual(again.settlement, ended.settlement, 'late explicit finish must not charge twice');
      await page.goto(servers.appOrigin);
      await page.waitForSelector('#scenario option', { state: 'attached' });
      await page.selectOption('#game', 'circuit');
      await launch('normal');
      assert.notEqual(current.id, abandonedId);
      await end();
    });
    await t.test('hidden presentation waits; visible missing video times out; retry recovers the same session', async () => {
      await page.addInitScript(playerOrigin => {
        if (location.origin !== playerOrigin || sessionStorage.getItem('suppress-track-once')) return;
        sessionStorage.setItem('suppress-track-once', '1');
        window.testHidden = true;
        Object.defineProperty(document, 'hidden', { get: () => window.testHidden });
        const NativePeer = RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePeer {
          constructor(...args) { super(...args); window.testTransport = this; }
          // Keep real ICE/data channels, but simulate a missing presentation track.
          set ontrack(_handler) {}
        };
      }, servers.playerOrigin);
      const frame = await launch('normal', { waitForFrames: false });
      const count = (await store.pool.query('SELECT count(*)::int AS n FROM streaming_sessions')).rows[0].n;
      const id = current.id;
      await frame.waitForFunction(() => window.testTransport?.connectionState === 'connected');
      assert.equal(await frame.evaluate(() => window.playerStats.presented), 0);
      assert.notEqual(await page.textContent('#stream-status'), 'Live', 'ICE alone is not playable video');
      await frame.waitForTimeout(16_000);
      assert.notEqual(await frame.evaluate(() => window.playerStats.state), 'failed', 'hidden presentation must not falsely fail');
      await frame.evaluate(() => {
        window.testHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await frame.waitForFunction(() => window.playerStats.state === 'failed', null, { timeout: 20_000 });
      assert.match(await page.textContent('#stream-status'), /Connection timed out/);
      assert(await frame.isVisible('#retry'));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: new URL('../artifacts/connection-failed-mobile.png', import.meta.url).pathname, fullPage: true });
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const navigated = frame.waitForNavigation();
      await frame.click('#retry');
      await navigated;
      await frame.waitForFunction(() => window.playerStats.presented > 15, null, { timeout: 15_000 });
      assert.equal(await frame.isVisible('#retry'), false);
      await page.waitForFunction(() => document.querySelector('#stream-status').textContent === 'Live');
      await frame.click('button[aria-label="Accelerate"]');
      await frame.waitForFunction(() => window.playerStats.inputAcknowledged >= 2);
      assert.equal(current.id, id);
      assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM streaming_sessions')).rows[0].n, count, 'retry must not allocate another session');
      await page.setViewportSize({ width: 1440, height: 1050 });
      await end();
    });
    await t.test('read and settlement endpoints reject incorrect session capabilities', async () => {
      for (const suffix of ['', '/finish']) {
        const response = await fetch(`${servers.appOrigin}/api/sessions/${current.id}${suffix}`, { method: suffix ? 'POST' : 'GET', headers: { authorization: 'Bearer wrong' } });
        assert.equal(response.status, 404);
      }
    });
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (agent) await agent.close();
    if (servers) await servers.close();
    if (store) await store.close();
    await database.stop();
  }
});
