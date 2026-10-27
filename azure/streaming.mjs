import { app } from '@azure/functions';
import { timingSafeEqual } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { catalog, scenarios, qualities, validateLaunch } from '../src/domain.mjs';

const store = await createStore(process.env.YOM_STREAMING_DATABASE_URL || process.env.YOM_AZURE_DATABASE_URL);
const agentKey = process.env.YOM_AGENT_KEY;
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicSession = ({ token, lease_token, lease_until, capture_context, ...row }) => row;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

async function json(request) {
  let bytes = 0;
  const chunks = [];
  if (request.body) for await (const chunk of request.body) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) fail(413, 'Request body is too large.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { fail(400, 'Invalid JSON.'); }
}

async function session(request, player = false) {
  const row = await store.get(request.params.id);
  if (!row || (player && !sameSecret(request.headers.get('authorization'), `Bearer ${row.token}`))) fail(404, 'Session not found.');
  return row;
}

function register(name, method, route, handler, { agent = false, status = 200 } = {}) {
  app.http(name, { methods: [method], route, authLevel: 'anonymous',
    handler: async function streamingRequest(request, context) {
      const headers = { 'x-yom-backend': 'azure-functions', 'x-yom-invocation-id': context.invocationId, 'cache-control': 'no-store' };
      try {
        if (agent && (!agentKey || !sameSecret(request.headers.get('authorization'), `Bearer ${agentKey}`))) fail(401, 'Unauthorized agent.');
        return { status, headers, jsonBody: await handler(request) };
      } catch (error) {
        const code = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
        return { status: code, headers, jsonBody: { message: code === 500 ? 'Streaming service unavailable.' : error.message } };
      }
    },
  });
}

register('streamingCatalog', 'GET', 'catalog', async () => ({ games: catalog, scenarios, qualities, playerOrigin: process.env.YOM_PLAYER_ORIGIN }));
register('streamingSessions', 'GET', 'sessions', async () => (await store.list()).map(publicSession));
register('launchStream', 'POST', 'launch', async request => {
  const row = await store.launch(validateLaunch(await json(request)));
  return { ...publicSession(row), playerToken: row.token };
}, { status: 202 });
register('getStream', 'GET', 'sessions/{id}', async request => publicSession(await session(request, true)));
register('finishStream', 'POST', 'sessions/{id}/finish', async request => {
  const row = await session(request, true);
  return publicSession(await store.finish(row.id));
});

register('claimStreamJob', 'GET', 'agent/jobs', async () => ({ job: await store.claim() }), { agent: true });
register('streamJobStarted', 'POST', 'agent/jobs/{id}/started', async request => {
  const body = await json(request);
  if (!uuid(request.params.id) || !uuid(body?.lease) || !Object.hasOwn(qualities, body?.quality)) fail(400, 'Invalid job acknowledgement.');
  const row = await store.started(request.params.id, body.lease, body.quality);
  if (!row) fail(409, 'Lease expired.');
  return publicSession(row);
}, { agent: true });
register('streamJobFailed', 'POST', 'agent/jobs/{id}/failed', async request => {
  const body = await json(request);
  if (!uuid(request.params.id) || !uuid(body?.lease)) fail(400, 'Invalid job acknowledgement.');
  const row = await store.fail(request.params.id, body.lease, {
    code: String(body.error?.code || 'HOST_START').slice(0, 100), message: String(body.error?.message || 'Game host failed.').slice(0, 1000),
  });
  if (!row) fail(409, 'Lease expired.');
  return publicSession(row);
}, { agent: true });

register('authorizeStreamPeer', 'POST', 'agent/sessions/{id}/authorize', async request => {
  const body = await json(request), row = await session(request);
  if (!['host', 'player'].includes(body?.role) || !sameSecret(body.token, row.token)
    || !['allocating', 'streaming'].includes(row.state)) fail(404, 'Session not found.');
  return publicSession(row);
}, { agent: true });
register('getAgentStream', 'GET', 'agent/sessions/{id}', async request => publicSession(await session(request)), { agent: true });
register('recordStreamInput', 'POST', 'agent/sessions/{id}/input', async request => {
  const body = await json(request), row = await session(request);
  if (!Number.isSafeInteger(body?.sequence) || body.sequence < 0 || typeof body.action !== 'string') fail(400, 'Invalid input acknowledgement.');
  const evidence = { sequence: body.sequence, action: body.action.slice(0, 20), appliedAt: Date.now() };
  await store.input(row.id, evidence);
  return evidence;
}, { agent: true });
register('releaseAbandonedStream', 'POST', 'agent/sessions/{id}/finish', async request => {
  const row = await session(request);
  return publicSession(await store.finish(row.id));
}, { agent: true });
app.hook.appTerminate(async () => store.close());
