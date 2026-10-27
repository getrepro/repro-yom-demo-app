import { GenericContainer, Wait } from 'testcontainers';
import { randomBytes } from 'node:crypto';
import { startServers } from './server.mjs';
import { forkAgent } from './fork-agent.mjs';

const password = randomBytes(16).toString('hex');
const database = await new GenericContainer('postgres:16-alpine')
  .withEnvironment({ POSTGRES_PASSWORD: password, POSTGRES_DB: 'circuit_demo' })
  .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2)).start();
let servers, agent, closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await agent?.close(); await servers?.close(); await database.stop();
}
try {
  // The password is confined to this disposable container and is never logged.
  const databaseUrl = `postgresql://postgres:${password}@${database.getHost()}:${database.getMappedPort(5432)}/circuit_demo`;
  const agentKey = randomBytes(32).toString('base64url');
  servers = await startServers({ databaseUrl, agentKey, appPort: Number(process.env.YOM_APP_PORT ?? 5385), playerPort: Number(process.env.YOM_PLAYER_PORT ?? 5386) });
  agent = await forkAgent({ ...servers, agentKey });
  console.log(`Circuit streaming app: ${servers.appOrigin}`);
  console.log(`Player origin: ${servers.playerOrigin}`);
  console.log(`Streaming business API: ${servers.apiOrigin}/api (local Azure Functions)`);
  console.log(process.env.REPRO_ENABLED === 'true' ? 'Repro capture enabled; business data stays in the disposable local database.' : 'SDK-off baseline. See .env.example to connect the YOM feature SDKs.');
} catch (error) { await close(); throw error; }
process.on('SIGTERM', close); process.on('SIGINT', close);
