import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketToday, marketDate } from '../market-time';
import { dailyWindowFor } from '../ohlc-window';
import { shouldCacheFailure } from '../cache-policy';

// 11:13pm ET on 2026-09-22 is 03:13 UTC on 2026-09-23. The UTC clock has
// already rolled over; the market's has not. This is the window in which every
// OHLC call used to 422.
const LATE_EVENING_ET = new Date('2026-09-23T03:13:00Z');

test('marketToday resolves to the Eastern date, not the UTC one', () => {
  assert.equal(LATE_EVENING_ET.toISOString().slice(0, 10), '2026-09-23');
  assert.equal(marketToday(LATE_EVENING_ET), '2026-09-22');
});

test('end_date never exceeds the current Eastern date', () => {
  const { endDate } = dailyWindowFor('2026-09-22', LATE_EVENING_ET);
  assert.equal(endDate, '2026-09-22', 'a future EST date is what UW 422s on');
});

test('end_date still reaches +45d for a month that has fully elapsed', () => {
  const { key, endDate } = dailyWindowFor('2026-05-11', LATE_EVENING_ET);
  assert.equal(key, '2026-05');
  assert.equal(endDate, '2026-07-16');
  assert.ok(endDate < marketToday(LATE_EVENING_ET));
});

test('marketToday holds across the DST boundary', () => {
  // EST (UTC-5) in January: the date rolls at 05:00 UTC, not 04:00.
  assert.equal(marketToday(new Date('2026-01-16T04:30:00Z')), '2026-01-15');
  assert.equal(marketToday(new Date('2026-01-16T05:30:00Z')), '2026-01-16');
  // EDT (UTC-4) in July.
  assert.equal(marketToday(new Date('2026-07-16T03:30:00Z')), '2026-07-15');
  assert.equal(marketToday(new Date('2026-07-16T04:30:00Z')), '2026-07-16');
});

test("a late-evening rating is dated to the session it was published in", () => {
  assert.equal(marketDate('2026-09-23T03:13:00Z'), '2026-09-22');
  // Pre-market, where UTC and ET agree.
  assert.equal(marketDate('2026-09-22T12:30:00Z'), '2026-09-22');
});

test('a 422 is never written to the cache', () => {
  assert.equal(shouldCacheFailure({ status: 422, retryable: false }), false);
});

test('only a 404 is worth remembering', () => {
  assert.equal(shouldCacheFailure({ status: 404, retryable: false }), true);
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    assert.equal(
      shouldCacheFailure({ status, retryable: status === 429 || status >= 500 }),
      false,
      `${status} should not be cached`
    );
  }
  assert.equal(shouldCacheFailure(new Error('socket hang up')), false);
});
