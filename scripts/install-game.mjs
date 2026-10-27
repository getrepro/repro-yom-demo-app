import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const commit = '2d72c7f11f7619e6be83833289122b83f21dc494';
const root = new URL('../vendor/bananabread/', import.meta.url);
const runtime = new Set(['README.md', 'cube2/bb.js', 'cube2/bb.wasm', 'cube2/base.data',
  'cube2/character.data', 'cube2/low.data', 'cube2/crunch-worker.js']);
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Game download failed: HTTP ${response.status} at ${url}`);
  return response;
}
const tree = await (await get(`https://api.github.com/repos/kripken/BananaBread/git/trees/${commit}?recursive=1`)).json();
if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete upstream manifest');
const files = tree.tree.filter(entry => entry.type === 'blob' && (runtime.has(entry.path)
  || /^cube2\/(js|game)\//.test(entry.path)
  || /licen[cs]e|copyright|readme|author/i.test(entry.path)));
const manifest = [];
for (const file of files) {
  if (file.path.includes('..') || file.path.startsWith('/') || file.size > 32 * 1024 * 1024) throw new Error('Invalid game asset');
  const target = new URL(file.path, root);
  let bytes = await readFile(target).catch(() => null);
  if (!bytes || blobHash(bytes) !== file.sha) {
    bytes = Buffer.from(await (await get(`https://raw.githubusercontent.com/kripken/BananaBread/${commit}/${file.path}`)).arrayBuffer());
    if (bytes.length !== file.size || blobHash(bytes) !== file.sha) throw new Error(`Integrity mismatch: ${file.path}`);
    await mkdir(dirname(fileURLToPath(target)), { recursive: true });
    await writeFile(target, bytes);
  }
  manifest.push({ path: file.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`Verified ${file.path} (${bytes.length} bytes)`);
}
await writeFile(new URL('manifest.json', root), JSON.stringify({ commit, files: manifest }, null, 2));
console.log('BananaBread installed locally. Upstream notices are retained; no production resources changed.');
