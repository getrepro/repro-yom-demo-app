export async function reserveCapacity(job) {
  const origin = process.env.YOM_AZURE_ORIGIN;
  if (!origin) throw new Error('The streaming worker requires its Azure Functions backend.');
  const url = new URL('/api/capacity', origin);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('The PoC uses local Azure Functions only.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, quality: job.requested_quality, scenario: job.scenario }), signal: AbortSignal.timeout(10000) });
    if (response.status === 503 && attempt < 2) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw Object.assign(new Error('Capacity service is unavailable.'), { code: 'CAPACITY_SERVICE' });
    const result = await response.json();
    if (result.jobId !== job.id || typeof result.accepted !== 'boolean') throw new Error('Invalid capacity reservation.');
    if (!result.accepted) throw Object.assign(new Error('No streaming capacity is available in this region.'), { code: 'GPU_CAPACITY' });
    return result;
  }
}
