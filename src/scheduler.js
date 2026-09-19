'use strict';

/**
 * Schedules the daily automatic scrape at 09:30 AM Armenia Standard Time
 * (UTC+4 — no DST observed).
 *
 * 09:30 Armenia → cron: "30 9 * * *" in the Asia/Yerevan timezone.
 *
 * Usage:
 *   const { startScheduler } = require('./scheduler');
 *   startScheduler({ telegram: bot.telegram, chatId: process.env.NOTIFY_CHAT_ID });
 */

const cron = require('node-cron');
const logger = require('./logger');
const { config } = require('./config');
const { runFullScrape } = require('./bot/scraperActions');
const { startDeadlineNotifier, stopDeadlineNotifier } = require('./procurement/deadlineNotifier');

const ARMENIA_TIMEZONE = 'Asia/Yerevan';
const SCRAPE_CRON = config.dailyScrapeCron;
const DAILY_SCRAPE_TIME = process.env.DAILY_SCRAPE_TIME || '09:30';

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
    timezone: ARMENIA_TIMEZONE,
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
      timezone: ARMENIA_TIMEZONE,
    }
  );

  logger.info('Daily scrape next run calculated', {
    nextRun: schedulerTask.getNextRun()?.toString() || 'unknown',
  });

  // Start deadline notifications scheduler (hourly checks)
  startDeadlineNotifier({ telegram, chatId });

  logger.info(`Scheduler started — daily scrape at ${DAILY_SCRAPE_TIME} Armenia time`);
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
  stopDeadlineNotifier();
}

module.exports = { startScheduler, stopScheduler, SCRAPE_CRON, ARMENIA_TIMEZONE, DAILY_SCRAPE_TIME };
