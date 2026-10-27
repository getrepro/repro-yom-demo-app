import { readReproConfig, initializeBackendCapture } from './repro-config.mjs';

const captureConfig = await readReproConfig();
await initializeBackendCapture(captureConfig);
const { startAgent } = await import('./agent.mjs');

let agent;
let stopping = false;
process.on('message', async message => {
  if (message.type === 'start' && !agent) {
    try { agent = await startAgent(message.config); process.send({ type: 'ready' }); }
    catch (error) { process.send({ type: 'error', message: error.message }); process.exitCode = 1; process.disconnect(); }
  }
  if (message.type === 'stop' && !stopping) {
    stopping = true;
    try {
      await agent?.close();
      if (captureConfig) {
        const { flushRepro } = await import('@reproapp/node-sdk');
        const delivery = await flushRepro({ timeoutMs: 30000 });
        // A failed, bounded drain must not silently retry forever at process exit.
        if (!delivery.complete) process.exit(1);
      }
      process.disconnect();
    } catch {
      console.error('Streaming agent shutdown failed; capture delivery is not confirmed.');
      process.exit(1);
    }
  }
});
