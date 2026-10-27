import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { GenericContainer, Wait } from 'testcontainers';
import { chromium } from 'playwright';
import { createStore } from '../src/store.mjs';
import { startServers } from '../src/server.mjs';
import { forkAgent } from '../src/fork-agent.mjs';

process.env.REPRO_ENABLED = 'false';

test('unmodified BananaBread runs on the host; cross-origin player receives video and sends real controls', { timeout: 150_000 }, async () => {
  const db = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'game-test', POSTGRES_DB: 'game_test' })
    .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2)).start();
  let store, servers, agent, browser;
  try {
    store = await createStore(`postgresql://postgres:game-test@${db.getHost()}:${db.getMappedPort(5432)}/game_test`);
    const agentKey = 'local-real-game-test-agent';
    servers = await startServers({ store, agentKey });
    agent = await forkAgent({ ...servers, agentKey, pollMs: 100 });
    // Full Chromium mirrors the deployed browser more closely than headless-shell.
    browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    const downloads = [];
    page.on('request', req => { if (/\.(wasm|data)(\?|$)/.test(req.url())) downloads.push(req.url()); });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(servers.appOrigin);
    await page.selectOption('#game', 'bananabread');
    const launched = page.waitForResponse(res => res.url().endsWith('/api/launch') && res.request().method() === 'POST');
    await page.click('#launch');
    const session = await (await launched).json();
    try { await page.waitForSelector('#player-container iframe', { timeout: 70_000 }); }
    catch (error) { console.error('Launch failure:', (await store.get(session.id)).error_message); throw error; }
    const frame = await (await page.$('#player-container iframe')).contentFrame();
    await frame.waitForFunction(() => window.playerStats.presented > 15, null, { timeout: 25_000 });
    assert.notEqual(new URL(frame.url()).origin, servers.appOrigin);
    assert.deepEqual(downloads, [], 'user must receive video, not the game engine or game data');
    const picture = () => frame.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 128; c.height = 72;
      const g = c.getContext('2d'); g.drawImage(document.querySelector('video'), 0, 0, 128, 72);
      return Array.from(g.getImageData(0, 0, 128, 72).data);
    });
    const before = await picture();
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await frame.locator('video').screenshot({ path: new URL('../artifacts/bananabread-before.png', import.meta.url).pathname });
    assert(new Set(before).size > 80, 'game world must be rendered, not a loading/blank screen');
    const bounds = await frame.locator('video').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 120, bounds.y + bounds.height / 2, { steps: 20 });
    await page.mouse.up();
    await page.keyboard.down('w'); await page.waitForTimeout(1300); await page.keyboard.up('w');
    await frame.waitForFunction(() => window.playerStats.inputAcknowledged >= 2);
    const after = await picture();
    await frame.locator('video').screenshot({ path: new URL('../artifacts/bananabread-after.png', import.meta.url).pathname });
    assert(after.filter((value, i) => Math.abs(value - before[i]) > 10).length > 1500, 'mouse look and movement must change the scene before bots spawn');
    await page.keyboard.press('Escape');
    const beforeFire = await frame.evaluate(() => window.playerStats.inputAcknowledged);
    await frame.getByRole('button', { name: 'Fire', exact: true }).click();
    await frame.waitForFunction(sequence => window.playerStats.inputAcknowledged >= sequence + 2, beforeFire);
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await frame.waitForFunction(() => window.playerStats.state === 'live');
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: new URL('../artifacts/bananabread-desktop.png', import.meta.url).pathname, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    // Bring the outer iframe onscreen before waiting for its rendering ticks.
    await page.evaluate(() => document.querySelector('#active').scrollIntoView({ behavior: 'instant', block: 'start' }));
    const presented = await frame.evaluate(() => window.playerStats.presented);
    await frame.waitForFunction(before => window.playerStats.presented > before + 2, presented);
    assert(new Set(await picture()).size > 80, 'mobile video must remain playable after resizing');
    await page.screenshot({ path: new URL('../artifacts/bananabread-mobile.png', import.meta.url).pathname, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.click('#end');
    await page.waitForFunction(() => !document.querySelector('#launch').disabled);
    const ended = await store.get(session.id);
    assert.equal(ended.state, 'ended');
    assert.equal(ended.settlement.chargedCents, ended.settlement.contractCents);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await agent?.close(); await servers?.close(); await store?.close(); await db.stop();
  }
});
