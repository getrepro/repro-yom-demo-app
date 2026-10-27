const { app } = require('@azure/functions');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.YOM_AZURE_DATABASE_URL, max: 4 });

async function reserve(job, invocationId) {
  if (!job || typeof job.id !== 'string' || job.id.length > 128 || !['standard', 'high'].includes(job.quality)) {
    return { status: 400, jsonBody: { message: 'Invalid capacity request.' } };
  }
  const { rows } = await pool.query(`INSERT INTO azure_capacity(job_id, quality, accepted, attempts, invocation_id)
    VALUES ($1,$2,$3,1,$4) ON CONFLICT (job_id) DO UPDATE SET attempts=azure_capacity.attempts+1
    RETURNING *`, [job.id, job.quality, job.scenario !== 'allocation', invocationId]);
  const row = rows[0];
  // Explicit fault scenarios exercise idempotent retries and exhausted failures.
  if (job.scenario === 'capacity-unavailable' || (job.scenario === 'capacity-retry' && row.attempts === 1)) {
    return { status: 503, jsonBody: { message: 'Capacity temporarily unavailable.' } };
  }
  return { status: 200, jsonBody: { jobId: row.job_id, accepted: row.accepted, quality: row.quality } };
}

app.http('reserveCapacity', { methods: ['POST'], route: 'capacity', authLevel: 'anonymous',
  handler: async function reserveCapacity(request, context) { return reserve(await request.json(), context.invocationId); } });
app.hook.appTerminate(async () => pool.end());
