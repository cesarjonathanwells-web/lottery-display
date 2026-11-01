const test = require('node:test');
const assert = require('node:assert/strict');
const { toLocalTime, drawTimezone, isUSLottery } = require('./utils');

const SUMMER = '2026-10-31';
const WINTER = '2026-11-01';

test('summer: Eastern and AST read the same', () => {
  assert.equal(toLocalTime('2:30 PM', SUMMER), '2:30 PM');
  assert.equal(toLocalTime('11:40 PM', SUMMER), '11:40 PM');
});

test('winter: US draws read an hour later', () => {
  const cases = {
    '12:30 PM': '1:30 PM', '1:00 PM': '2:00 PM', '1:30 PM': '2:30 PM',
    '2:00 PM': '3:00 PM', '2:30 PM': '3:30 PM', '7:00 PM': '8:00 PM',
    '10:00 PM': '11:00 PM', '10:30 PM': '11:30 PM',
  };
  for (const [et, ast] of Object.entries(cases)) assert.equal(toLocalTime(et, WINTER), ast);
});

test('winter: late draws wrap past midnight', () => {
  assert.equal(toLocalTime('11:00 PM', WINTER), '12:00 AM');
  assert.equal(toLocalTime('11:40 PM', WINTER), '12:40 AM');
});

test('flips back on the March change', () => {
  assert.equal(toLocalTime('2:30 PM', '2027-03-13'), '3:30 PM');
  assert.equal(toLocalTime('2:30 PM', '2027-03-14'), '2:30 PM');
});

test('bad input comes back unchanged', () => {
  assert.equal(toLocalTime('Midday', WINTER), 'Midday');
  assert.equal(toLocalTime('2:30 PM', 'nope'), '2:30 PM');
});

test('only US lotteries run on Eastern', () => {
  for (const id of ['newyork', 'florida', 'georgia', 'newjersey', 'connecticut']) {
    assert.equal(isUSLottery(id), true);
    assert.equal(drawTimezone(id), 'America/New_York');
  }
  for (const id of ['anguilla', 'nacional', 'kinglottery', 'ocean']) {
    assert.equal(isUSLottery(id), false);
    assert.equal(drawTimezone(id), 'America/Tortola');
  }
});
