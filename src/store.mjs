import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { settleSession } from './domain.mjs';
import { enqueueContext } from './job-transport.mjs';

export async function createStore(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 8 });
  // Only a dedicated demo database may be supplied. Never use a Repro evidence DB.
  await pool.query(`CREATE TABLE IF NOT EXISTS streaming_sessions (
    id uuid PRIMARY KEY, game_id text NOT NULL, scenario text NOT NULL,
    requested_quality text NOT NULL, actual_quality text, contract_rate integer NOT NULL,
    state text NOT NULL DEFAULT 'queued', token text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, ended_at timestamptz,
    lease_until timestamptz, lease_token uuid, error_code text, error_message text,
    settlement jsonb, last_input jsonb
  )`);
  await pool.query('ALTER TABLE streaming_sessions ADD COLUMN IF NOT EXISTS capture_context jsonb');
  return {
    pool,
    async launch({ game, quality, scenario }) {
      const result = await pool.query(`INSERT INTO streaming_sessions
        (id, game_id, scenario, requested_quality, contract_rate, token, capture_context)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), game.id, scenario, quality, game.centsPerMinute, randomBytes(24).toString('base64url'), enqueueContext()]);
      return result.rows[0];
    },
    async get(id) {
      if (!/^[a-f\d-]{36}$/i.test(id)) return null;
      return (await pool.query('SELECT * FROM streaming_sessions WHERE id=$1', [id])).rows[0] ?? null;
    },
    async list() {
      return (await pool.query('SELECT * FROM streaming_sessions ORDER BY created_at DESC LIMIT 30')).rows;
    },
    async claim() {
      return (await pool.query(`UPDATE streaming_sessions SET state='allocating', lease_until=now()+interval '30 seconds', lease_token=$1
        WHERE id=(SELECT id FROM streaming_sessions WHERE state='queued'
          OR (state='allocating' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`, [randomUUID()])).rows[0] ?? null;
    },
    async started(id, lease, quality) {
      return (await pool.query(`UPDATE streaming_sessions SET state='streaming', actual_quality=$3,
        started_at=now(), lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='allocating' RETURNING *`,
      [id, lease, quality])).rows[0] ?? null;
    },
    async fail(id, lease, error) {
      return (await pool.query(`UPDATE streaming_sessions SET state='failed', error_code=$3,
        error_message=$4, ended_at=now(), lease_until=NULL
        WHERE id=$1 AND lease_token=$2 AND state='allocating' RETURNING *`,
      [id, lease, error.code ?? 'HOST_START', error.message])).rows[0] ?? null;
    },
    async input(id, data) {
      await pool.query('UPDATE streaming_sessions SET last_input=$2 WHERE id=$1 AND state=$3', [id, data, 'streaming']);
    },
    async finish(id) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = (await client.query('SELECT * FROM streaming_sessions WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!row) throw Object.assign(new Error('Session not found.'), { status: 404 });
        if (row.state === 'ended' || row.state === 'failed') {
          await client.query('COMMIT');
          return row;
        }
        const endedAt = Date.now();
        const settlement = row.started_at ? settleSession(row, endedAt) : null;
        const updated = (await client.query(`UPDATE streaming_sessions SET state='ended', ended_at=$2,
          settlement=$3, lease_until=NULL WHERE id=$1 RETURNING *`, [id, new Date(endedAt), settlement])).rows[0];
        await client.query('COMMIT');
        return updated;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}
