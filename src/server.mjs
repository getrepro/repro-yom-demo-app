import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { readReproConfig, browserConfig, sdkPaths } from './repro-config.mjs';
import { startAzureLocal } from '../scripts/azure-local.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startServers({ store, databaseUrl = store?.pool.options.connectionString, agentKey,
  appPort = 0, playerPort = 0, disconnectGraceMs = 15000 }) {
  const app = express();
  const player = express();
  const appServer = createServer(app);
  const playerServer = createServer(player);
  const sockets = new Server(playerServer, { maxHttpBufferSize: 64 * 1024 });
  let appOrigin, functionsHost, stateTimer;
  const reproConfig = await readReproConfig();
  const captureConfig = browserConfig(reproConfig);
  const browserBundle = captureConfig.enabled ? sdkPaths().browserBundle : null;
  const peers = new Map();
  const disconnects = new Map();
  let closing = false;
  app.use('/assets', express.static(`${root}node_modules/lucide/dist/umd`));
  app.use(express.static(`${root}public/app`));
  app.get('/api/repro-config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.json(captureConfig.enabled ? { ...captureConfig,
      options: { ...captureConfig.options, iframeCapture: { allowedOrigins: [playerOrigin],
        ...(reproConfig.mediaApiBase ? { mediaApiBase: reproConfig.mediaApiBase } : {}) } } } : captureConfig);
  });
  const serveSdk = (_req, res) => browserBundle ? res.sendFile(browserBundle) : res.sendStatus(404);
  app.get('/repro/browser.js', serveSdk);
  player.use('/vendor', express.static(`${root}node_modules/phaser/dist`));
  player.get('/repro/browser.js', serveSdk);
  player.get('/api/repro-frame-config', (_req, res) => res.json({ enabled: captureConfig.enabled, parentOrigin: appOrigin }));
  player.use('/assets', express.static(`${root}node_modules/lucide/dist/umd`));
  player.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${appOrigin}`);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  player.use(express.static(`${root}public/player`));
  player.use('/games/bananabread', express.static(`${root}vendor/bananabread/cube2`, { index: false }));

  // Same-origin development proxy only. Functions owns every business endpoint;
  // preserve request bytes, query correlation, headers, status and response body.
  app.use('/api', (req, res) => {
    const target = new URL(functionsHost.origin);
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, method: req.method,
      path: req.originalUrl, headers: { ...req.headers, host: target.host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(65000, () => upstream.destroy(new Error('Functions request timed out.')));
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ message: 'Azure Functions is unavailable.' });
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  const backend = async (path, body) => {
    const response = await fetch(`${functionsHost.origin}/api/agent${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json', 'x-repro-capture-mode': 'off' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Streaming backend returned ${response.status}`);
    return response.json();
  };

  sockets.use(async (socket, next) => {
    try {
      const { sessionId, token, role, key } = socket.handshake.auth;
      const validRole = role === 'host' || role === 'player';
      if (!validRole || typeof sessionId !== 'string' || (role === 'host' && !sameSecret(key, agentKey))) return next(new Error('Unauthorized stream.'));
      const session = await backend(`/sessions/${encodeURIComponent(sessionId)}/authorize`, { token, role });
      socket.data.session = session;
      socket.data.role = role;
      next();
    } catch { next(new Error('Unable to authorize stream.')); }
  });
  sockets.on('connection', socket => {
    const session = socket.data.session;
    const role = socket.data.role;
    const key = `${session.id}:${role}`;
    // One player and one host per session. A replacement tears down the old peer.
    const oldPeer = peers.get(key);
    if (oldPeer) sockets.sockets.get(oldPeer)?.disconnect(true);
    peers.set(key, socket.id);
    if (role === 'player') { clearTimeout(disconnects.get(session.id)); disconnects.delete(session.id); }
    socket.join(session.id);
    const partnerKey = `${session.id}:${role === 'host' ? 'player' : 'host'}`;
    const partner = peers.get(partnerKey);
    if (partner) {
      sockets.to(partner).emit('peer-ready');
      socket.emit('peer-ready');
    }
    socket.on('signal', message => {
      if (!message || !['offer', 'answer', 'candidate'].includes(message.type)) return;
      const recipient = peers.get(partnerKey);
      if (recipient) sockets.to(recipient).emit('signal', message);
    });
    socket.on('input-applied', async message => {
      if (role !== 'host' || !Number.isSafeInteger(message?.sequence)) return;
      let evidence;
      try { evidence = await backend(`/sessions/${session.id}/input`, { sequence: message.sequence, action: String(message.action).slice(0, 20) }); }
      catch { return; }
      const recipient = peers.get(partnerKey);
      if (recipient) sockets.to(recipient).emit('input-applied', evidence);
    });
    socket.on('disconnect', () => {
      if (peers.get(key) !== socket.id) return;
      peers.delete(key);
      const recipient = peers.get(partnerKey);
      if (recipient) sockets.to(recipient).emit('peer-left');
      if (role === 'player' && !closing) {
        clearTimeout(disconnects.get(session.id));
        // Browser crashes must not leave game hosts rendering and charging forever.
        const expire = async () => {
          disconnects.delete(session.id);
          if (closing || peers.has(key)) return;
          try {
            await backend(`/sessions/${session.id}/finish`, {});
            sockets.to(session.id).emit('session-ended');
          } catch {
            if (!closing) disconnects.set(session.id, setTimeout(expire, disconnectGraceMs));
          }
        };
        disconnects.set(session.id, setTimeout(expire, disconnectGraceMs));
      }
    });
  });
  await new Promise((resolve, reject) => {
    playerServer.once('error', reject);
    playerServer.listen(playerPort, '127.0.0.1', resolve);
  });
  const playerOrigin = `http://127.0.0.1:${playerServer.address().port}`;
  try {
    functionsHost = await startAzureLocal({ databaseUrl,
      env: { YOM_AGENT_KEY: agentKey, YOM_PLAYER_ORIGIN: playerOrigin } });
    await new Promise((resolve, reject) => {
      appServer.once('error', reject);
      appServer.listen(appPort, '127.0.0.1', resolve);
    });
  } catch (error) { await new Promise(resolve => sockets.close(resolve)); await functionsHost?.stop(); throw error; }
  appOrigin = `http://127.0.0.1:${appServer.address().port}`;
  let checking = false;
  stateTimer = setInterval(async () => {
    if (checking || closing) return;
    checking = true;
    try {
      // The transport observes state; only Functions can finish and settle it.
      for (const id of new Set([...peers.keys()].map(key => key.split(':')[0]))) {
        try {
          const row = await backend(`/sessions/${id}`);
          if (row.state === 'ended' || row.state === 'failed') sockets.to(id).emit('session-ended');
        } catch { /* Keep a transient backend outage from dropping the stream. */ }
      }
    } finally { checking = false; }
  }, 500);
  return { appOrigin, playerOrigin, apiOrigin: functionsHost.origin, async close() {
    closing = true;
    clearInterval(stateTimer);
    for (const timer of disconnects.values()) clearTimeout(timer);
    disconnects.clear();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => appServer.close(resolve));
    await functionsHost.stop();
  } };
}
