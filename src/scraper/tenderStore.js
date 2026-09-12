'use strict';

/**
 * Persists scrape results to disk and compares consecutive scrapes
 * to detect newly published tenders.
 *
 * Storage layout (in <project>/data/):
 *   last-scrape.json  — the most recent completed scrape
 *   prev-scrape.json  — the scrape before that (kept for one cycle)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LAST_SCRAPE_PATH = path.join(DATA_DIR, 'last-scrape.json');
const PREV_SCRAPE_PATH = path.join(DATA_DIR, 'prev-scrape.json');

/**
 * Loads and returns the stored scrape from `last-scrape.json`.
 * Returns null if the file doesn't exist yet.
 *
 * @returns {{ tenders: Array, scrapedAt: string }|null}
 */
function loadLastScrape() {
  if (!fs.existsSync(LAST_SCRAPE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LAST_SCRAPE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Saves the current scrape result, moving the previous one to prev-scrape.json.
 *
 * @param {Array<{name: string, date: string|null, link: string}>} tenders
 */
function saveScrape(tenders) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Rotate: last → prev
  if (fs.existsSync(LAST_SCRAPE_PATH)) {
    fs.copyFileSync(LAST_SCRAPE_PATH, PREV_SCRAPE_PATH);
  }

  const payload = {
    tenders,
    scrapedAt: new Date().toISOString(),
  };

  fs.writeFileSync(LAST_SCRAPE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Parses a date string in DD.MM.YYYY or YYYY-MM-DD format.
 * Returns a Date object, or null if unparseable.
 *
 * @param {string|null} dateStr
 * @returns {Date|null}
 */
function parseDate(dateStr) {
  if (!dateStr) return null;

  // DD.MM.YYYY
  const dmy = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const dt = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // ISO / YYYY-MM-DD
  const iso = new Date(dateStr);
  return isNaN(iso.getTime()) ? null : iso;
}

/**
 * Returns the newest publication date found in a list of tenders.
 * Tenders without a parseable date are ignored.
 *
 * @param {Array<{date: string|null}>} tenders
 * @returns {Date|null}
 */
function newestDate(tenders) {
  let max = null;
  for (const t of tenders) {
    const d = parseDate(t.date);
    if (!d) continue;
    if (!max || d > max) max = d;
  }
  return max;
}

/**
 * Compares a fresh scrape against the previous one and returns only
 * the tenders whose publication date is strictly newer than the
 * previous scrape's newest date.
 *
 * @param {Array<{name, date, link}>} freshTenders
 * @param {{ tenders: Array, scrapedAt: string }|null} prevScrape
 * @returns {{ newTenders: Array, prevNewest: Date|null, freshNewest: Date|null }}
 */
function findNewTenders(freshTenders, prevScrape) {
  const prevNewest = prevScrape ? newestDate(prevScrape.tenders) : null;
  const freshNewest = newestDate(freshTenders);

  if (!prevNewest) {
    // No previous scrape — everything is "new" for notification purposes,
    // but we don't want to flood the channel on first run.
    return { newTenders: [], prevNewest: null, freshNewest };
  }

  // Tenders whose date is strictly after the previous scrape's newest date
  const newTenders = freshTenders.filter((t) => {
    const d = parseDate(t.date);
    return d && d > prevNewest;
  });

  return { newTenders, prevNewest, freshNewest };
}

module.exports = {
  loadLastScrape,
  saveScrape,
  findNewTenders,
  parseDate,
  newestDate,
};
