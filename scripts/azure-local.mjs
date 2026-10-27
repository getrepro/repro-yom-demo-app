import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { GenericContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const azure = path.join(root, 'azure');

async function availablePort(preferred = 0) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(preferred, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

export async function waitFor(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

export async function startAzureLocal({ env = {}, databaseUrl, port = 0, verbose = false } = {}) {
  let postgres, azurite, pool, child;
  let logs = '';
  let stopped = false;
  const stopHost = async (signal = 'SIGTERM') => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      // Core Tools owns a host and language worker. Terminate the entire group.
      process.kill(-child.pid, signal);
      const killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
      try { await exit; } finally { clearTimeout(killer); }
    }
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await stopHost();
    await pool?.end();
    await azurite?.stop();
    await postgres?.stop();
  };
  try {
    if (databaseUrl) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname)) throw new Error('Demo Functions require a local business database.');
    } else {
      postgres = await new GenericContainer('postgres:16-alpine')
        .withEnvironment({ POSTGRES_PASSWORD: 'yom-local', POSTGRES_DB: 'yom_azure' })
        .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2)).start();
      databaseUrl = `postgresql://postgres:yom-local@${postgres.getHost()}:${postgres.getMappedPort(5432)}/yom_azure`;
    }
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS azure_capacity(job_id text PRIMARY KEY, quality text NOT NULL, accepted boolean NOT NULL, attempts integer NOT NULL, invocation_id text NOT NULL);
    `);
    const localKey = Buffer.from('repro-yom-local-azurite-only').toString('base64');
    azurite = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite:3.35.0')
      .withEnvironment({ AZURITE_ACCOUNTS: `yomlocal:${localKey}` })
      .withCommand(['azurite', '--blobHost', '0.0.0.0', '--queueHost', '0.0.0.0', '--tableHost', '0.0.0.0', '--skipApiVersionCheck', '--disableTelemetry'])
      .withExposedPorts(10000, 10001, 10002).withWaitStrategy(Wait.forListeningPorts()).start();
    // The .NET Storage SDK reconstructs parent URLs as host-style for localhost,
    // losing container/queue names. Numeric loopback selects emulator path-style.
    const storageHost = azurite.getHost() === 'localhost' ? '127.0.0.1' : azurite.getHost();
    const storage = `DefaultEndpointsProtocol=http;AccountName=yomlocal;AccountKey=${localKey};`
      + `BlobEndpoint=http://${storageHost}:${azurite.getMappedPort(10000)}/yomlocal;`
      + `QueueEndpoint=http://${storageHost}:${azurite.getMappedPort(10001)}/yomlocal;`
      + `TableEndpoint=http://${storageHost}:${azurite.getMappedPort(10002)}/yomlocal;`;
    const hostPort = await availablePort(port);
    const origin = `http://127.0.0.1:${hostPort}`;
    const variables = { ...process.env, ...env,
      PATH: `${path.join(root, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}`,
      FUNCTIONS_WORKER_RUNTIME: 'node', FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR: 'true',
      AzureWebJobsStorage: storage, AzureWebJobsSecretStorageType: 'files',
      YOM_AZURE_DATABASE_URL: databaseUrl, YOM_STREAMING_DATABASE_URL: databaseUrl,
      AzureFunctionsJobHost__extensionBundle__downloadPath: path.join(root, 'artifacts/azure-bundles'),
      FUNCTIONS_CORE_TOOLS_TELEMETRY_OPTOUT: '1',
    };
    // Never inherit Azure cloud-account settings into this disposable host.
    delete variables.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete variables.APPINSIGHTS_INSTRUMENTATIONKEY;
    const startHost = async () => {
      logs = '';
      child = spawn(path.join(root, 'node_modules/.bin/func'), ['start', '--port', String(hostPort)],
        { cwd: azure, env: variables, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      const output = data => { logs = (logs + data.toString()).slice(-20000); if (verbose) process.stdout.write(data); };
      child.stdout.on('data', output); child.stderr.on('data', output);
      await waitFor(async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`Functions host exited (${child.exitCode}): ${logs}`);
        try {
          const response = await fetch(`${origin}/admin/host/status`, { signal: AbortSignal.timeout(1000) });
          return response.ok && (await response.json()).state === 'Running' && logs.includes('launchStream:');
        } catch { return false; }
      }, 'Functions host startup', 150000);
    };
    await startHost();
    return { origin, pool, storage, stop, logs: () => logs, get child() { return child; },
      restart: async ({ crash = false } = {}) => {
        if (stopped) throw new Error('Cannot restart a stopped Functions fixture');
        await stopHost(crash ? 'SIGKILL' : 'SIGTERM');
        await startHost();
      } };
  } catch (error) { await stop(); throw new Error(`${error.message}\n${logs}`, { cause: error }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await startAzureLocal({ port: Number(process.env.YOM_AZURE_PORT || 7073), verbose: true });
  console.log(`YOM local Azure Functions: ${instance.origin}/api/catalog`);
  console.log(`Repro capture: ${process.env.REPRO_ENABLED === 'true' ? 'enabled with supplied config' : 'OFF'}`);
  console.log('Local PostgreSQL and Azurite only; no Azure account or subscription used.');
  process.once('SIGINT', () => instance.stop());
  process.once('SIGTERM', () => instance.stop());
  instance.child.once('exit', () => instance.stop());
}
