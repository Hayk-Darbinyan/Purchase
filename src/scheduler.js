'use strict';

/**
 * Schedules the daily automatic scrape at 09:30 AM Armenia Standard Time
 * (UTC+4 — no DST observed).
 *
 * 09:30 Armenia = 05:30 UTC → cron: "30 5 * * *"
 *
 * Usage:
 *   const { startScheduler } = require('./scheduler');
 *   startScheduler({ telegram: bot.telegram, chatId: process.env.NOTIFY_CHAT_ID });
 */

const cron = require('node-cron');
const logger = require('./logger');
const { runFullScrape } = require('./bot/scraperActions');

// 09:30 AM Armenia time = 05:30 AM UTC (Armenia is UTC+4, no DST)
const SCRAPE_CRON = '30 5 * * *';

let schedulerTask = null;

/**
 * Starts the daily scrape scheduler.
 *
 * @param {object} opts
 * @param {object} opts.telegram  - Telegraf bot.telegram instance
 * @param {string} opts.chatId    - Telegram chat ID to send notifications to
 */
function startScheduler({ telegram, chatId }) {
  if (schedulerTask) {
    logger.warn('Scheduler already running — skipping duplicate start');
    return;
  }

  if (!chatId) {
    logger.warn(
      'NOTIFY_CHAT_ID is not set — daily scrape will run but notifications will not be sent.'
    );
  }

  logger.info('Starting daily scrape scheduler', {
    schedule: SCRAPE_CRON,
    timezone: 'UTC (09:30 Armenia / 05:30 UTC)',
    chatId: chatId || 'not configured',
  });

  schedulerTask = cron.schedule(
    SCRAPE_CRON,
    async () => {
      logger.info('Daily scrape triggered by scheduler');
      try {
        await runFullScrape({ telegram, chatId, silent: false });
      } catch (err) {
        logger.error('Scheduled scrape failed', { error: err.message });
      }
    },
    {
      timezone: 'UTC', // cron times are in UTC; we've already converted to UTC above
    }
  );

  logger.info('Scheduler started — next scrape at 05:30 UTC (09:30 Armenia)');
}

/**
 * Stops the scheduler (useful for testing or graceful shutdown).
 */
function stopScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Scheduler stopped');
  }
}

module.exports = { startScheduler, stopScheduler };
