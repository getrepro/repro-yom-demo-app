import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLaunch, allocateStream, settleSession } from '../src/domain.mjs';

test('launch validation rejects unknown qualities and inherited object keys', () => {
  for (const field of ['scenario', 'quality']) for (const value of ['constructor', '__proto__', '', null]) {
    assert.throws(() => validateLaunch({ gameId: 'circuit', scenario: 'normal', quality: 'high', [field]: value }));
  }
  assert.equal(validateLaunch({ gameId: 'circuit', scenario: 'normal', quality: 'high' }).game.centsPerMinute, 20);
});
test('healthy settlement follows started streaming time with exact minute boundaries', () => {
  const row = { started_at: '2026-10-12T12:00:00.000Z', contract_rate: 20, scenario: 'normal' };
  const start = new Date(row.started_at).getTime();
  for (const [duration, expected] of [[0, 0], [1, 20], [60000, 20], [60001, 40], [180000, 60]]) {
    const receipt = settleSession(row, start + duration);
    assert.equal(receipt.chargedCents, expected);
    assert.equal(receipt.chargedCents, receipt.contractCents);
  }
});
test('faults are distinct business failures, not a fake error log', () => {
  assert.throws(() => allocateStream({ scenario: 'allocation' }), { code: 'GPU_CAPACITY' });
  assert.equal(allocateStream({ scenario: 'quality', requested_quality: 'high' }).height, 540);
  assert.equal(allocateStream({ scenario: 'normal', requested_quality: 'high' }).height, 720);
  const receipt = settleSession({ started_at: 0, contract_rate: 20, scenario: 'billing' }, 60001);
  assert.equal(receipt.chargedCents, 60);
  assert.equal(receipt.contractCents, 40);
});
