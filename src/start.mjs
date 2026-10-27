import { randomBytes } from 'node:crypto';
import { startServers } from './server.mjs';
import { forkAgent } from './fork-agent.mjs';

if (!process.env.YOM_DEMO_DATABASE_URL) throw new Error('Set YOM_DEMO_DATABASE_URL to a dedicated local PostgreSQL database.');
const database = new URL(process.env.YOM_DEMO_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) {
  throw new Error('Demo business data must remain in local PostgreSQL.');
}
let servers, agent;
try {
  const agentKey = randomBytes(32).toString('base64url');
  servers = await startServers({ databaseUrl: database.toString(), agentKey, appPort: Number(process.env.YOM_APP_PORT ?? 5385),
    playerPort: Number(process.env.YOM_PLAYER_PORT ?? 5386) });
  agent = await forkAgent({ ...servers, agentKey });
  console.log(`Circuit streaming app: ${servers.appOrigin}`);
  console.log(`Cross-origin player: ${servers.playerOrigin}`);
  console.log(`Streaming business API: ${servers.apiOrigin}/api (local Azure Functions)`);
} catch (error) {
  if (servers) await servers.close();
  throw error;
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await agent.close();
  await servers.close();
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
