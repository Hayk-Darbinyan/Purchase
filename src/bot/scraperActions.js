'use strict';

/**
 * Orchestrates the full scrape pipeline:
 *   1. Launch browser → collectAllTenders (all tenders, no keyword filter)
 *   2. Save to tenderStore; compare with previous scrape
 *   3. For each newly detected tender: send Telegram notification
 *   4. For each new tender: download ZIP → extract → check keyword in hraver.docx
 *      – If NOT found: delete ZIP + extracted dir, move to next tender
 *      – If found: extract structured data → normalize DOCX → run search pipeline
 *        → send normalized DOCX + search results to Telegram
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
const { upsertTender } = require('../procurement/procurementStore');


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
 * Returns true when the given text matches at least one keyword.
 * Matching is case-insensitive substring check.
 */
function matchesKeyword(text, keywords) {
  const lower = (text || '').toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sends a Telegram message to `chatId`.
 * `telegram` is the Telegraf `ctx.telegram` (or `bot.telegram`) instance.
 */
async function sendTg(telegram, chatId, text) {
  try {
    await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn('Failed to send Telegram message in HTML mode, falling back to plain text', { error: err.message });
    try {
      const plain = text.replace(/<[^>]+>/g, '');
      await telegram.sendMessage(chatId, plain);
    } catch (fallbackErr) {
      logger.error('Failed to send Telegram message fallback', { error: fallbackErr.message });
    }
  }
}

/**
 * Recursively deletes a directory (best-effort, no throw on failure).
 */
function deleteDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Could not delete directory', { path: dirPath, error: err.message });
  }
}

/**
 * Deletes a file (best-effort, no throw on failure).
 */
function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn('Could not delete file', { path: filePath, error: err.message });
  }
}

/**
 * Processes one tender end-to-end:
 *   1. Download ZIP
 *   2. Extract ZIP
 *   3. Read hraver.docx and search for keyword
 *      – If NOT found: delete ZIP + extracted dir, return false (skip)
 *      – If found: continue with full processing pipeline
 *   4. Extract structured data from DOCX
 *   5. Generate normalized DOCX → save to procurementStore
 *   6. Run search pipeline (AI Mode / Google SERP)
 *   7. Send results to Telegram
 *
 * @param {object} tender       - { name, date, startDate, endDate, link }
 * @param {object} context      - { browser, telegram, chatId }
 * @returns {Promise<boolean>}  - true if keyword matched & processed, false if skipped
 */
async function processTender(tender, { browser, telegram, chatId }) {
  const detailPage = await browser.newPage();

  try {
    logger.info('Checking tender for keyword match', { name: tender.name, link: tender.link });

    // ── 1. Download ZIP ──────────────────────────────────────────────────────
    const zipPath = await downloadInviteZip(detailPage, tender.link, DOWNLOAD_DIR);
    if (!zipPath) {
      logger.info('No invitation download found, skipping tender', { name: tender.name });
      return false;
    }
    logger.info('ZIP downloaded', { name: tender.name, zipPath });

    // ── 2. Extract ZIP ───────────────────────────────────────────────────────
    const { extractDir, source, files } = await extractAndReadDocuments(zipPath);

    if (!files.length) {
      logger.info('No readable documents in ZIP, skipping tender', { name: tender.name });
      deleteFile(zipPath);
      deleteDir(extractDir);
      return false;
    }

    // ── 3. Find hraver.docx and check for keyword ────────────────────────────
    const keywords = getKeywords();

    // Prefer a file literally named "hraver.docx"; fall back to the first file
    const hraverFile =
      files.find((f) => path.basename(f.path).toLowerCase() === 'hraver.docx') || files[0];
    const docxPath = hraverFile.path;
    const hraverText = hraverFile.text;

    const keywordFound = matchesKeyword(hraverText, keywords);

    if (!keywordFound) {
      logger.info('Keyword NOT found in hraver.docx — deleting files and skipping', {
        name: tender.name,
        keywords,
      });
      deleteFile(zipPath);
      deleteDir(extractDir);
      return false;
    }

    logger.info('Keyword found in hraver.docx — proceeding with full pipeline', {
      name: tender.name,
      keywords,
    });

    // Notify that a keyword match was found (now confirmed by file contents)
    if (telegram && chatId) {
      await sendTg(
        telegram,
        chatId,
        `✅ <b>Keyword match found in hraver.docx:</b>\n${escapeHtml(tender.name)}\n\nProcessing...`
      );
    }

    // ── 4. Extract structured data from DOCX ────────────────────────────────
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
      if (telegram && chatId) {
        await sendTg(
          telegram,
          chatId,
          `❌ Failed to extract data from DOCX for:\n<b>${escapeHtml(tender.name)}</b>\n${escapeHtml(err.message)}`
        );
      }
      return false;
    }

    // ── 5. Generate normalized DOCX ─────────────────────────────────────────
    let normalizedBuffer;
    try {
      normalizedBuffer = await generateNormalizedDocx(extractedData);
    } catch (err) {
      logger.error('DOCX normalization failed', { name: tender.name, error: err.message });
      if (telegram && chatId) {
        await sendTg(
          telegram,
          chatId,
          `❌ Failed to generate normalized DOCX for:\n<b>${escapeHtml(tender.name)}</b>\n${escapeHtml(err.message)}`
        );
      }
      return false;
    }

    // Save normalized DOCX alongside the source
    const normalizedPath = path.join(
      path.dirname(docxPath),
      `normalized_${path.basename(docxPath)}`
    );
    fs.writeFileSync(normalizedPath, normalizedBuffer);

    // ── Save to procurement store ────────────────────────────────────────────
    // Calculate total price from procurement items table
    let tenderPrice = 0;
    let hasAnyPrice = false;
    if (extractedData && Array.isArray(extractedData.procurementItems)) {
      for (const item of extractedData.procurementItems) {
        const rawPrice = item.price || item.unitPrice;
        if (rawPrice) {
          // Strip non-numeric characters (spaces, dots, commas used as separators)
          const cleaned = String(rawPrice)
            .replace(/\u00A0/g, '')
            .replace(/\s/g, '')
            .replace(/\./g, '')
            .replace(/,/g, '.');
          const num = parseFloat(cleaned);
          if (!isNaN(num) && num > 0) {
            tenderPrice += num;
            hasAnyPrice = true;
          }
        }
      }
    }
    if (!hasAnyPrice) {
      tenderPrice = null;
    }

    try {
      upsertTender({
        name: tender.name,
        link: tender.link,
        date: tender.date || null,
        startDate: tender.startDate || null,
        endDate: tender.endDate || null,
        price: tenderPrice,
        normalizedDocxPath: normalizedPath,
      });
      logger.info('Tender saved to procurement store', {
        name: tender.name,
        price: tenderPrice,
        endDate: tender.endDate,
      });
    } catch (storeErr) {
      logger.error('Failed to save tender to procurement store', {
        name: tender.name,
        error: storeErr.message,
      });
    }

    if (telegram && chatId) {
      await telegram.sendDocument(
        chatId,
        {
          source: normalizedBuffer,
          filename: `normalized_${path.basename(docxPath)}`,
        },
        {
          caption: `📄 Normalized DOCX for:\n<b>${escapeHtml(tender.name)}</b>`,
          parse_mode: 'HTML',
        }
      );
    }

    // ── 6. Run search pipeline (AI Mode / Google SERP) ──────────────────────
    if (telegram && chatId) {
      await sendTg(
        telegram,
        chatId,
        `🔍 Running market search for <b>${escapeHtml(tender.name)}</b>...`
      );
    }

    try {
      const { products, warnings, results } = await runPipeline(normalizedBuffer);

      if (telegram && chatId) {
        for (const w of warnings) {
          await sendTg(telegram, chatId, `⚠️ ${escapeHtml(w)}`);
        }

        if (!products.length) {
          await sendTg(
            telegram,
            chatId,
            `ℹ️ No product rows found in the normalized DOCX for:\n<b>${escapeHtml(tender.name)}</b>`
          );
          return true;
        }

        for (const r of results) {
          if (r.error) {
            await sendTg(
              telegram,
              chatId,
              `❌ Search error for "${r.product.name}": ${r.error}`
            );
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
      }
    } catch (err) {
      logger.error('Pipeline search failed', { name: tender.name, error: err.message });
      if (telegram && chatId) {
        await sendTg(
          telegram,
          chatId,
          `❌ Search failed for <b>${escapeHtml(tender.name)}</b>: ${escapeHtml(err.message)}`
        );
      }
    }

    return true;
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
        await sendTg(
          telegram,
          chatId,
          `✅ <b>Scrape complete.</b>\n` +
            `Total tenders: ${freshTenders.length}\n` +
            `No new tenders since last scrape.`
        );
      } else {
        await sendTg(
          telegram,
          chatId,
          `✅ <b>Scrape complete.</b>\n` +
            `Total: ${freshTenders.length} | 🆕 New: ${newTenders.length}\n` +
            `Now checking each new tender's hraver.docx for keyword matches...`
        );

        for (const t of newTenders) {
          await sendTg(
            telegram,
            chatId,
            `🆕 <b>New Tender</b>\n` +
              `📋 ${escapeHtml(t.name)}\n` +
              `📅 ${escapeHtml(t.date || 'date unknown')}\n` +
              `🔗 <a href="${t.link}">Open tender</a>`
          );
        }
      }
    }

    // ── 4. Process every new tender — keyword checked inside hraver.docx ────
    // (no upfront name-based filter; processTender handles keyword matching)
    const keywords = getKeywords();
    logger.info('Processing all new tenders (keyword check inside hraver.docx)', {
      keywords,
      newTenders: newTenders.length,
    });

    const matchedTenders = [];

    for (const tender of newTenders) {
      try {
        const matched = await processTender(tender, { browser, telegram, chatId });
        if (matched) matchedTenders.push(tender);
      } catch (err) {
        logger.error('Failed to process tender', { name: tender.name, error: err.message });
        if (telegram && chatId) {
          await sendTg(
            telegram,
            chatId,
            `❌ Error processing <b>${escapeHtml(tender.name)}</b>: ${escapeHtml(err.message)}`
          );
        }
      }
    }

    if (telegram && chatId && newTenders.length > 0) {
      await sendTg(
        telegram,
        chatId,
        `📊 <b>Processing complete.</b>\n` +
          `Checked: ${newTenders.length} new tender(s)\n` +
          `Keyword matches found: ${matchedTenders.length}`
      );
    }

    return { freshTenders, newTenders, matchedTenders };
  } catch (err) {
    logger.error('Full scrape failed', { error: err.message });
    if (telegram && chatId) {
      await sendTg(telegram, chatId, `❌ <b>Scrape failed:</b> ${escapeHtml(err.message)}`);
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runFullScrape, getKeywords, matchesKeyword, processTender };
