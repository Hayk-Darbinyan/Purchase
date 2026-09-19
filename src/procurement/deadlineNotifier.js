'use strict';

/**
 * Deadline notification scheduler for matched procurement tenders.
 *
 * Notification frequency (per day) based on days remaining until the
 * submission deadline:
 *
 *   5 or 4 days → 1 notification / day
 *   3 days      → 2 notifications / day
 *   2 days (or fewer until deadline) → 5 notifications / day
 *   < 0 days    → no notifications (deadline passed)
 *   submitted   → no notifications
 *
 * State is persisted in data/notification-state.json so restarts don't
 * reset counters.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Markup } = require('telegraf');

const logger = require('../logger');
const { config } = require('../config');
const {
  getAllTenders,
  daysUntilDeadline,
  markSubmitted,
  ARMENIA_TIMEZONE,
} = require('./procurementStore');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'notification-state.json');

// ── Notification frequency map ────────────────────────────────────────────────
function notificationsPerDay(daysLeft) {
  if (daysLeft === null || daysLeft < 0) return 0;
  if (daysLeft <= 2) return 5;
  if (daysLeft === 3) return 2;
  if (daysLeft <= 5) return 1;
  return 0;
}

function notificationBucket(daysLeft) {
  if (daysLeft === 4 || daysLeft === 5) return '5_4';
  if (daysLeft === 3) return '3';
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 2) return '2';
  return null;
}

// ── State persistence ─────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayKey() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: ARMENIA_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Runs one notification check cycle:
 * For each unsubmitted matched tender with an endDate, determines how many
 * notifications should be sent today and sends the ones still outstanding.
 */
async function runNotificationCheck({ telegram, chatId, bucket = null, respectSpacing = true }) {
  if (!telegram || !chatId) return;

  const tenders = getAllTenders();
  if (!tenders.length) return;

  const state = loadState();
  const today = todayKey();
  const nowMs = Date.now();
  let stateChanged = false;

  for (const tender of tenders) {
    // Skip submitted tenders
    if (tender.submittedAt) continue;

    const daysLeft = daysUntilDeadline(tender.endDate);
    const maxToday = notificationsPerDay(daysLeft);
    if (maxToday === 0) continue;
    if (bucket && notificationBucket(daysLeft) !== bucket) continue;

    // Initialise per-tender state
    if (!state[tender.id]) {
      state[tender.id] = { sentToday: 0, lastDate: null, lastSentTime: null };
      stateChanged = true;
    }

    const ts = state[tender.id];

    // Reset counter when day changes
    if (ts.lastDate !== today) {
      ts.sentToday = 0;
      ts.lastDate = today;
      ts.lastSentTime = null;
      stateChanged = true;
    }

    if (ts.sentToday >= maxToday) continue;

    // Spacing between notifications in the same day:
    // 1/day -> 20h min interval
    // 2/day -> 4h min interval
    // 5/day -> 2h min interval
    const minIntervalMs = maxToday === 1 ? 0 : (maxToday === 2 ? 4 * 3600 * 1000 : 2 * 3600 * 1000);
    if (respectSpacing && ts.lastSentTime && (nowMs - ts.lastSentTime < minIntervalMs)) {
      continue;
    }

    // Send notification
    try {
      const daysLabel = daysLeft === 0 ? 'այսօր' : (daysLeft === 1 ? '1 օր' : `${daysLeft} օր`);
      const text =
        `⏰ <b>Ժամկետի հիշեցում</b>\n\n` +
        `📋 <b>${escapeHtml(tender.name)}</b>\n\n` +
        `📅 Վերջնաժամկետ՝ <b>${escapeHtml(tender.endDate || '—')}</b>\n` +
        `⏳ Մնացել է՝ <b>${daysLabel}</b>\n\n` +
        `Հայտը ներկայացնելուց հետո սեղմեք ներքևի կոճակը՝ հետագա ծանուցումները դադարեցնելու համար։`;

      await telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Հայտը բեռնված է / ներկայացված է', `proc:submitted:${tender.id}`)],
          [Markup.button.url('🔗 Բացել հայտարարությունը', tender.link)],
        ]),
      });

      ts.sentToday += 1;
      ts.lastSentTime = nowMs;
      stateChanged = true;

      logger.info('Deadline notification sent', {
        tenderId: tender.id,
        daysLeft,
        sentToday: ts.sentToday,
        maxToday,
      });
    } catch (err) {
      logger.error('Failed to send deadline notification', {
        tenderId: tender.id,
        error: err.message,
      });
    }
  }

  if (stateChanged) saveState(state);
}

// ── Public API ────────────────────────────────────────────────────────────────

let notifierTasks = [];

/**
 * Marks a tender as submitted, both in the procurement store and in the
 * notification state, so all further notifications are suppressed.
 */
function markTenderSubmitted(tenderId) {
  const ok = markSubmitted(tenderId);
  if (ok) {
    const state = loadState();
    if (state[tenderId]) {
      state[tenderId].submitted = true;
    } else {
      state[tenderId] = { submitted: true };
    }
    saveState(state);
  }
  return ok;
}

/**
 * Starts the hourly deadline-notification scheduler.
 */
function startDeadlineNotifier({ telegram, chatId }) {
  if (notifierTasks.length) {
    logger.warn('Deadline notifier already running — skipping duplicate start');
    return;
  }

  if (!chatId) {
    logger.warn('NOTIFY_CHAT_ID not set — deadline notifications will not be sent');
    return;
  }

  const customSchedules = [
    { bucket: '5_4', crons: config.deadlineNotify54Crons },
    { bucket: '3', crons: config.deadlineNotify3Crons },
    { bucket: '2', crons: config.deadlineNotify2Crons },
  ];
  const hasCustomSchedules = customSchedules.some(({ crons }) => crons.length > 0);

  logger.info('Starting deadline notification scheduler', {
    mode: hasCustomSchedules ? 'configured times' : 'hourly',
    schedules: customSchedules,
  });

  // Run initial check after a brief delay
  setTimeout(() => {
    runNotificationCheck({ telegram, chatId }).catch((err) =>
      logger.error('Initial notification check failed', { error: err.message })
    );
  }, 5000);

  const schedules = hasCustomSchedules
    ? customSchedules.map(({ bucket, crons }) => ({
      bucket,
      crons: crons.length ? crons : ['0 * * * *'],
      respectSpacing: crons.length === 0,
    }))
    : [{ bucket: null, crons: ['0 * * * *'], respectSpacing: true }];

  for (const { bucket, crons, respectSpacing } of schedules) {
    for (const schedule of crons) {
      const task = cron.schedule(schedule, async () => {
        logger.info('Deadline notification check triggered', { schedule, bucket: bucket || 'all' });
        try {
          await runNotificationCheck({ telegram, chatId, bucket, respectSpacing });
        } catch (err) {
          logger.error('Deadline notification check failed', { error: err.message });
        }
      }, { timezone: ARMENIA_TIMEZONE });
      notifierTasks.push(task);
      logger.info('Deadline notification next run calculated', {
        schedule,
        bucket: bucket || 'all',
        nextRun: task.getNextRun()?.toString() || 'unknown',
      });
    }
  }
}

/**
 * Stops the scheduler (for testing or graceful shutdown).
 */
function stopDeadlineNotifier() {
  if (notifierTasks.length) {
    notifierTasks.forEach((task) => task.stop());
    notifierTasks = [];
    logger.info('Deadline notifier stopped');
  }
}

module.exports = {
  startDeadlineNotifier,
  stopDeadlineNotifier,
  markTenderSubmitted,
  runNotificationCheck,
  notificationsPerDay,
  notificationBucket,
};
