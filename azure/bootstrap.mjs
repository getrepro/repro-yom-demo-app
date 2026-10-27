import { readReproConfig, traceInclude } from '../src/repro-config.mjs';

const config = await readReproConfig();
if (config) {
  const { initRepro } = await import('@reproapp/node-sdk');
  await initRepro({
    tenantId: config.tenantId, appId: config.appId, appSecret: config.appSecret,
    appName: 'yom-azure-functions', serviceName: 'YOM Azure Functions',
    actorId: 'yom-synthetic-functions', actorType: 'worker',
    apiBase: config.apiBase, ingestBase: config.ingestBase,
    privacy: { captureRaw: config.captureRaw, environment: config.environment, apiBase: config.apiBase },
    automaticCapture: { azureFunctions: { delivery: 'storageQueue' } },
    tracing: { include: [traceInclude],
      disableFunctionTypes: ['constructor'], logFunctionCalls: false },
    // The streaming platform follows browser admission, including sampling.
    liveMode: { enabled: false },
  });
}
await import('./capacity.cjs');
await import('./streaming.mjs');
