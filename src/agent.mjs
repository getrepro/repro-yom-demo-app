import { chromium } from 'playwright';
import { allocateStream } from './domain.mjs';
import { startJobPolling } from './job-transport.mjs';
import { reserveCapacity } from './capacity.mjs';

export async function startAgent({ appOrigin, playerOrigin, agentKey, pollMs = 500 }) {
  const browser = await chromium.launch({ headless: true,
    // Only the dedicated game host advertises numeric candidates; user browsers
    // keep their normal privacy settings and need no multicast DNS resolution.
    args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const contexts = new Map();
  const request = async (path, body) => {
    const response = await fetch(`${appOrigin}/api/agent${path}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json',
        ...(path === '/jobs' ? { 'x-repro-capture-mode': 'off' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Agent request failed: ${response.status}`);
    return response.json();
  };
  async function launch(job) {
    let context;
    try {
      await reserveCapacity(job);
      const allocation = allocateStream(job);
      context = await browser.newContext({ viewport: { width: allocation.width, height: allocation.height } });
      const page = await context.newPage();
      page.on('pageerror', error => console.error('[game-host]', error.message));
      page.on('console', message => { if (message.type() === 'error') console.error('[game-host]', message.text()); });
      await page.addInitScript(config => { window.hostConfig = config; },
        { sessionId: job.id, token: job.token, key: agentKey, scenario: job.scenario, gameId: job.game_id, allocation });
      await page.exposeFunction('hostEnded', async () => {
        contexts.delete(job.id);
        await context.close();
      });
      await page.goto(`${playerOrigin}/${job.game_id === 'bananabread' ? 'bananabread' : 'host'}.html`);
      await page.waitForFunction(() => window.hostReady === true || window.gameLoadError, null, { timeout: 60_000 });
      const gameLoadError = await page.evaluate(() => window.gameLoadError);
      if (gameLoadError) throw new Error(gameLoadError);
      await request(`/jobs/${job.id}/started`, { lease: job.lease_token, quality: allocation.actualQuality });
      contexts.set(job.id, context);
    } catch (error) {
      if (context) await context.close();
      await request(`/jobs/${job.id}/failed`, { lease: job.lease_token,
        error: { code: error.code ?? 'HOST_START', message: error.message } }).catch(() => {});
    }
  }
  const polling = startJobPolling({ next: async () => (await request('/jobs')).job, process: launch,
    intervalMs: pollMs, available: () => contexts.size < 4,
    onError: error => console.error('[stream-agent]', error.message) });
  return { async close() {
    await polling.close();
    await browser.close();
  } };
}
