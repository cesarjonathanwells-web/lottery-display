const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { looksHalfStale, shouldHoldStale } } = require('./index');

const MIN = 60 * 1000;
const yesterday = { numbers: ['0', '8', '7', '-', '4', '0', '0', '9'], date: '2026-11-16' };
const halfStale = {
  numbers: ['2', '0', '0', '-', '4', '0', '0', '9'],
  parts: [['2', '0', '0'], ['4', '0', '0', '9']],
  date: '2026-11-17'
};

test("the sweep spots today's Pick 3 beside yesterday's Win 4", () => {
  // What the 5-minute sweep posted at 2:50 PM ET on 2026-11-17.
  assert.equal(looksHalfStale(yesterday, halfStale), true);
});

test('a result with every part new goes through', () => {
  const fresh = { numbers: ['2', '0', '0', '-', '4', '9', '6', '5'], date: '2026-11-17' };
  assert.equal(looksHalfStale(yesterday, fresh), false);
});

test("a same-day fix to one part is a correction, not stale", () => {
  const postedToday = { numbers: halfStale.numbers, date: '2026-11-17' };
  const corrected = { numbers: ['2', '0', '0', '-', '4', '9', '6', '5'], date: '2026-11-17' };
  assert.equal(looksHalfStale(postedToday, corrected), false);
});

test('single-number lotteries are never held', () => {
  const stored = { numbers: ['12', '34', '56'], date: '2026-11-16' };
  const result = { numbers: ['12', '40', '77'], date: '2026-11-17' };
  assert.equal(looksHalfStale(stored, result), false);
});

test('nothing stored yet means nothing to compare', () => {
  assert.equal(looksHalfStale(undefined, halfStale), false);
  assert.equal(looksHalfStale({ numbers: [], date: '2026-11-16' }, halfStale), false);
});

test('the hold gives up after an hour so a real repeat still posts', () => {
  const key = 'newyork|2:30 PM|2026-11-17';
  const t0 = Date.parse('2026-11-17T19:50:00Z');
  assert.equal(shouldHoldStale(key, yesterday, halfStale, t0), true);
  assert.equal(shouldHoldStale(key, yesterday, halfStale, t0 + 59 * MIN), true);
  assert.equal(shouldHoldStale(key, yesterday, halfStale, t0 + 60 * MIN), false);
});
