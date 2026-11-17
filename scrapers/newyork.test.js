const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { buildResult } } = require('./newyork');

// Shapes and values from the NY Lottery feed on 2026-11-17. drawTime is
// midnight Eastern on the draw date; status 22 = finished, 4 = not yet drawn.
const NOV17 = 1794891600000;
const NOV16 = 1794805200000;

function draw(drawTime, drawPeriod, primary) {
  return primary
    ? { drawTime, drawPeriod, status: 22, results: [{ primary }] }
    : { drawTime, drawPeriod, status: 4, results: [] };
}

function feed({ numbersToday, win4Today }) {
  return {
    numbers: { draws: [
      draw(NOV17, 2, null),
      draw(NOV17, 1, numbersToday),
      draw(NOV16, 2, ['4', '2', '7']),
      draw(NOV16, 1, ['0', '8', '7'])
    ] },
    win4: { draws: [
      draw(NOV17, 2, null),
      draw(NOV17, 1, win4Today),
      draw(NOV16, 2, ['2', '1', '2', '1']),
      draw(NOV16, 1, ['4', '0', '0', '9'])
    ] }
  };
}

test("today's Pick 3 is never paired with yesterday's Win 4", () => {
  // 2:46 PM ET on 2026-11-17: Pick 3 was up, Win 4 wasn't. The board posted
  // 200-4009, with 4009 from the day before.
  const data = feed({ numbersToday: ['2', '0', '0'], win4Today: null });
  assert.equal(buildResult(data, 'midday'), null);
});

test('Win 4 posted first is held the same way', () => {
  const data = feed({ numbersToday: null, win4Today: ['4', '9', '6', '5'] });
  assert.equal(buildResult(data, 'midday'), null);
});

test('both halves from the same draw go through', () => {
  const data = feed({ numbersToday: ['2', '0', '0'], win4Today: ['4', '9', '6', '5'] });
  assert.deepEqual(buildResult(data, 'midday'), {
    numbers: ['2', '0', '0', '-', '4', '9', '6', '5'],
    parts: [['2', '0', '0'], ['4', '9', '6', '5']],
    date: '2026-11-17',
    closed: false
  });
});

test("before tonight's draw, last night's evening result stands", () => {
  const data = feed({ numbersToday: ['2', '0', '0'], win4Today: ['4', '9', '6', '5'] });
  const result = buildResult(data, 'evening');
  assert.deepEqual(result.numbers, ['4', '2', '7', '-', '2', '1', '2', '1']);
  assert.equal(result.date, '2026-11-16');
});

test('missing feed or unknown session gives nothing', () => {
  assert.equal(buildResult(null, 'midday'), null);
  assert.equal(buildResult(feed({ numbersToday: null, win4Today: null }), 'night'), null);
});
