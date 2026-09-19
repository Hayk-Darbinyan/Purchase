'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDate, ARMENIA_TIMEZONE } = require('../src/procurement/procurementStore');
const { notificationsPerDay } = require('../src/procurement/deadlineNotifier');
const { SCRAPE_CRON, ARMENIA_TIMEZONE: SCHEDULER_TIMEZONE } = require('../src/scheduler');

test('deadline notification frequency matches the requested schedule', () => {
  assert.equal(notificationsPerDay(5), 1);
  assert.equal(notificationsPerDay(4), 1);
  assert.equal(notificationsPerDay(3), 2);
  assert.equal(notificationsPerDay(2), 5);
});

test('timezone-less tender dates are parsed as Armenia local time', () => {
  assert.equal(parseDate('2026-09-28 10:00:00').toISOString(), '2026-09-28T06:00:00.000Z');
  assert.equal(ARMENIA_TIMEZONE, 'Asia/Yerevan');
});

test('daily scrape cron is anchored to Armenia time', () => {
  assert.match(SCRAPE_CRON, /^\d+ \d+ \* \* \*$/);
  assert.equal(SCHEDULER_TIMEZONE, 'Asia/Yerevan');
});
