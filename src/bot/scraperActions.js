'use strict';

/**
 * Orchestrates the full scrape pipeline:
 *   1. Launch browser → collectAllTenders (all tenders, no keyword filter)
 *   2. Save to tenderStore; compare with previous scrape
 *   3. For each newly detected tender: send Telegram notification
 *   4. Apply keyword filter to the fresh batch
 *   5. For each matched tender: download ZIP → extract DOCX →
 *      docxDataExtractor → generateNormalizedDocx → runPipeline (search)
 *      → send normalized DOCX + search results to Telegram
 *
 * Both the automatic daily scheduler and the "Manual Scrape" bot button
 * call `runFullScrape()` from this module.
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const { config } = require('../config');
const logger = require('../logger');
const { collectAllTenders } = require('../scraper/allTendersScraper');
const { loadLastScrape, saveScrape, findNewTenders } = require('../scraper/tenderStore');
const { downloadInviteZip } = require('../scraper/download');
const { extractAndReadDocuments } = require('../scraper/extract');
const { extractDocxData } = require('../scraper/docxDataExtractor');
const { generateNormalizedDocx } = require('../normalize/docxNormalizer');
const { runPipeline } = require('../pipeline');
const { formatProductResult } = require('../format/telegramFormatter');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');

// Browser / context settings kept in one place
const BROWSER_OPTS = {
  headless: true,
};
const CONTEXT_OPTS = {
  acceptDownloads: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
  locale: 'hy-AM',
};

/**
 * Returns the configured keyword list (lower-cased) from the environment.
 * Falls back to the hard-coded default keyword used by the legacy scraper.
 */
function getKeywords() {
  const raw = config.keywords || 'համակարգիչ';
  return raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns true when the tender name matches at least one keyword.
 * Matching is case-insensitive substring check.
 */
function matchesKeyword(name, keywords) {
  const lower = (name || '').toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Sends a Telegram message to `chatId`.
 * `telegram` is the Telegraf `ctx.telegram` (or `bot.telegram`) instance.
 */
async function sendTg(telegram, chatId, text) {
  try {
    await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn('Failed to send Telegram message', { error: err.message });
  }
}

/**
 * Processes one keyword-matched tender end-to-end:
 *   download ZIP → extract DOCX → normalize → search → send results
 *
 * @param {object} tender       - { name, date, link }
 * @param {object} context      - { browser, telegram, chatId }
 */
async function processTender(tender, { browser, telegram, chatId }) {
  const detailPage = await browser.newPage();
  try {
    logger.info('Processing keyword-matched tender', { name: tender.name, link: tender.link });

    // ── 1. Download ZIP ─────────────────────────────────────────────────────
    await sendTg(telegram, chatId,
      `⏳ <b>Keyword match found:</b>\n${tender.name}\n\nDownloading...`);

    const zipPath = await downloadInviteZip(detailPage, tender.link, DOWNLOAD_DIR);
    if (!zipPath) {
      await sendTg(telegram, chatId,
        `⚠️ No invitation download found for:\n<b>${tender.name}</b>`);
      return;
    }

    // ── 2. Extract DOCX files from ZIP ──────────────────────────────────────
    const { extractDir, source, files } = await extractAndReadDocuments(zipPath);
    if (!files.length) {
      await sendTg(telegram, chatId,
        `⚠️ No readable documents found in the ZIP for:\n<b>${tender.name}</b>`);
      return;
    }

    // Find the first hraver.docx (or any .docx if none named hraver)
    let docxPath = files[0].path;
    const hraverFile = files.find((f) => path.basename(f.path).toLowerCase() === 'hraver.docx');
    if (hraverFile) docxPath = hraverFile.path;

    // ── 3. Extract structured data from DOCX ────────────────────────────────
    let extractedData;
    try {
      const { data, meta } = await extractDocxData(docxPath);
      extractedData = data;
      logger.info('DOCX data extracted', {
        name: tender.name,
        items: meta.itemRowCount,
        specs: meta.techSpecRowCount,
      });
    } catch (err) {
      logger.error('DOCX extraction failed', { name: tender.name, error: err.message });
      await sendTg(telegram, chatId,
        `❌ Failed to extract data from DOCX for:\n<b>${tender.name}</b>\n${err.message}`);
      return;
    }

    // ── 4. Generate normalized DOCX ─────────────────────────────────────────
    let normalizedBuffer;
    try {
      normalizedBuffer = await generateNormalizedDocx(extractedData);
    } catch (err) {
      logger.error('DOCX normalization failed', { name: tender.name, error: err.message });
      await sendTg(telegram, chatId,
        `❌ Failed to generate normalized DOCX for:\n<b>${tender.name}</b>\n${err.message}`);
      return;
    }

    // Save normalized DOCX alongside the source
    const normalizedPath = path.join(
      path.dirname(docxPath),
      `normalized_${path.basename(docxPath)}`
    );
    fs.writeFileSync(normalizedPath, normalizedBuffer);

    // Send the normalized DOCX to the chat
    await telegram.sendDocument(chatId, {
      source: normalizedBuffer,
      filename: `normalized_${path.basename(docxPath)}`,
    }, {
      caption: `📄 Normalized DOCX for:\n<b>${tender.name}</b>`,
      parse_mode: 'HTML',
    });

    // ── 5. Run search pipeline (AI Mode / Google SERP) ──────────────────────
    await sendTg(telegram, chatId,
      `🔍 Running market search for <b>${tender.name}</b>...`);

    try {
      const { products, warnings, results } = await runPipeline(normalizedBuffer);

      for (const w of warnings) {
        await sendTg(telegram, chatId, `⚠️ ${w}`);
      }

      if (!products.length) {
        await sendTg(telegram, chatId,
          `ℹ️ No product rows found in the normalized DOCX for:\n<b>${tender.name}</b>`);
        return;
      }

      for (const r of results) {
        if (r.error) {
          await sendTg(telegram, chatId,
            `❌ Search error for "${r.product.name}": ${r.error}`);
          continue;
        }
        const text = formatProductResult(r.product, r.result);
        try {
          await telegram.sendMessage(chatId, text, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: false,
          });
        } catch {
          // Strip MarkdownV2 escapes for plain-text fallback
          const plain = text
            .replace(/\\([_*[\]()~`>#+=|{}.!\\\-])/g, '$1')
            .replace(/[*_~`]/g, '');
          await sendTg(telegram, chatId, plain);
        }
      }
    } catch (err) {
      logger.error('Pipeline search failed', { name: tender.name, error: err.message });
      await sendTg(telegram, chatId,
        `❌ Search failed for <b>${tender.name}</b>: ${err.message}`);
    }
  } finally {
    await detailPage.close().catch(() => {});
  }
}

/**
 * Main entry point — runs the full scrape + comparison + notification + processing pipeline.
 *
 * @param {object} opts
 * @param {object} opts.telegram   - Telegraf telegram instance (bot.telegram)
 * @param {string} opts.chatId     - Telegram chat ID to send notifications to
 * @param {boolean} [opts.silent]  - If true, suppress "Scraping…" status messages
 * @returns {Promise<{ freshTenders: Array, newTenders: Array, matchedTenders: Array }>}
 */
async function runFullScrape({ telegram, chatId, silent = false }) {
  const listingUrl = config.tenderListingUrl;
  if (!listingUrl) {
    const msg = '❌ TENDER_LISTING_URL is not configured. Cannot run scrape.';
    logger.error(msg);
    if (telegram && chatId) await sendTg(telegram, chatId, msg);
    return { freshTenders: [], newTenders: [], matchedTenders: [] };
  }

  if (!silent && telegram && chatId) {
    await sendTg(telegram, chatId, '🔄 <b>Scrape started...</b> This may take a few minutes.');
  }

  logger.info('Starting full scrape', { listingUrl });

  let browser;
  try {
    browser = await chromium.launch(BROWSER_OPTS);
    const context = await browser.newContext(CONTEXT_OPTS);
    const listingPage = await context.newPage();

    // ── 1. Scrape all tenders ───────────────────────────────────────────────
    const freshTenders = await collectAllTenders(listingPage, listingUrl);
    await listingPage.close().catch(() => {});

    // ── 2. Compare with previous scrape ────────────────────────────────────
    const prevScrape = loadLastScrape();
    saveScrape(freshTenders);

    const { newTenders, prevNewest, freshNewest } = findNewTenders(freshTenders, prevScrape);

    logger.info('Scrape comparison complete', {
      total: freshTenders.length,
      new: newTenders.length,
      prevNewest: prevNewest ? prevNewest.toISOString() : 'none',
      freshNewest: freshNewest ? freshNewest.toISOString() : 'none',
    });

    // ── 3. Notify about new tenders ─────────────────────────────────────────
    if (telegram && chatId) {
      if (newTenders.length === 0) {
        await sendTg(telegram, chatId,
          `✅ <b>Scrape complete.</b>\n` +
          `Total tenders: ${freshTenders.length}\n` +
          `No new tenders since last scrape.`);
      } else {
        await sendTg(telegram, chatId,
          `✅ <b>Scrape complete.</b>\n` +
          `Total: ${freshTenders.length} | 🆕 New: ${newTenders.length}`);

        for (const t of newTenders) {
          await sendTg(telegram, chatId,
            `🆕 <b>New Tender</b>\n` +
            `📋 ${t.name}\n` +
            `📅 ${t.date || 'date unknown'}\n` +
            `🔗 <a href="${t.link}">Open tender</a>`);
        }
      }
    }

    // ── 4. Keyword matching on the full fresh batch ─────────────────────────
    const keywords = getKeywords();
    const matchedTenders = freshTenders.filter((t) => matchesKeyword(t.name, keywords));
    // Only process tenders that are NEW (to avoid re-processing every run)
    const newMatchedTenders = newTenders.filter((t) => matchesKeyword(t.name, keywords));

    logger.info('Keyword matching result', {
      keywords,
      matched: matchedTenders.length,
      newMatched: newMatchedTenders.length,
    });

    if (telegram && chatId && newMatchedTenders.length === 0 && newTenders.length > 0) {
      await sendTg(telegram, chatId,
        `ℹ️ No new keyword-matched tenders among the ${newTenders.length} new ones.`);
    }

    // ── 5. Process each new keyword-matched tender ──────────────────────────
    for (const tender of newMatchedTenders) {
      try {
        await processTender(tender, { browser, telegram, chatId });
      } catch (err) {
        logger.error('Failed to process tender', { name: tender.name, error: err.message });
        if (telegram && chatId) {
          await sendTg(telegram, chatId,
            `❌ Error processing <b>${tender.name}</b>: ${err.message}`);
        }
      }
    }

    return { freshTenders, newTenders, matchedTenders };
  } catch (err) {
    logger.error('Full scrape failed', { error: err.message });
    if (telegram && chatId) {
      await sendTg(telegram, chatId, `❌ <b>Scrape failed:</b> ${err.message}`);
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runFullScrape, getKeywords, matchesKeyword, processTender };
