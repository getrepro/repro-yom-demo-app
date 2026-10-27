export const scenarios = Object.freeze({
  normal: 'Healthy session',
  allocation: 'No GPU capacity',
  'capacity-retry': 'Capacity check retries',
  'capacity-unavailable': 'Capacity service unavailable',
  quality: 'Wrong stream quality',
  billing: 'Wrong session rate',
  'source-freeze': 'Game host freezes',
  'presentation-stall': 'Player stops presenting',
  'delayed-controls': 'Input delivery delayed',
  'late-freeze': 'Freeze after three minutes',
});

export const catalog = Object.freeze([
  { id: 'bananabread', title: 'BananaBread', category: 'Arena FPS', studio: 'Cube 2 / Mozilla',
    description: 'A complete arena shooter, streamed from a separate game host.', centsPerMinute: 20 },
  { id: 'circuit', title: 'Circuit / 01', category: 'Time trial', studio: 'Repro Arcade',
    description: 'Find your line. A precision circuit through the night.', centsPerMinute: 20 },
]);

export const qualities = Object.freeze({
  standard: { width: 960, height: 540, fps: 30 },
  high: { width: 1280, height: 720, fps: 60 },
});

export function validateLaunch(input) {
  const game = catalog.find(item => item.id === input?.gameId);
  if (!game || !Object.hasOwn(qualities, input?.quality) || !Object.hasOwn(scenarios, input?.scenario)) {
    throw Object.assign(new Error('Choose a valid game, quality and scenario.'), { status: 400 });
  }
  return { game, quality: input.quality, scenario: input.scenario };
}

export function allocateStream(session) {
  if (session.scenario === 'allocation') {
    throw Object.assign(new Error('No streaming capacity is available in this region.'), { code: 'GPU_CAPACITY' });
  }
  // Intentional incident: fallback chooses a lower tier but launch still succeeds.
  const actualQuality = session.scenario === 'quality' ? 'standard' : session.requested_quality;
  return { actualQuality, ...qualities[actualQuality] };
}

export function settleSession(session, endedAt) {
  const started = new Date(session.started_at).getTime();
  const elapsedMs = Math.max(0, endedAt - started);
  if (!Number.isFinite(elapsedMs)) throw new Error('Cannot settle a session without a start time.');
  const minutes = Math.ceil(elapsedMs / 60_000);
  // Intentional incident: premium rate leaks into the standard contract.
  const appliedRate = session.scenario === 'billing' ? 30 : session.contract_rate;
  return { elapsedMs, billedMinutes: minutes, appliedRate, chargedCents: minutes * appliedRate,
    contractCents: minutes * session.contract_rate };
}
