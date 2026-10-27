import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readReproConfig, sdkPaths } from './repro-config.mjs';

const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
if (await readReproConfig()) sdkPaths();
// Static/signaling transport is not a business backend. The Functions host and
// separate polling worker initialize Repro in their own processes.
if (process.argv.includes('--dev')) await import('./dev.mjs');
else await import('./start.mjs');
