'use strict';

/**
 * Telegram bot handlers for all inline buttons and commands added in this sprint:
 *
 *  - /scrape          Manual scrape trigger (same as the inline button)
 *  - callback: "scrape"         → Manual Scrape button
 *  - callback: "tender_list"    → Tender List (paginated, click to download)
 *  - callback: "tender_dl:<id>" → Download tender ZIP and send extracted files
 *  - callback: "normalize"      → Prompt user to send a raw DOCX for normalization
 *  - callback: "search"         → Prompt user to send a normalized DOCX for search
 *
 * Document messages are also handled here when the bot is in "normalize" or
 * "search" session mode (tracked per-user via a lightweight in-memory session).
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { Markup } = require('telegraf');

const logger = require('../logger');
const { config } = require('../config');
const { runFullScrape } = require('./scraperActions');
const { extractDocxData } = require('../scraper/docxDataExtractor');
const { generateNormalizedDocx } = require('../normalize/docxNormalizer');
const { runPipeline } = require('../pipeline');
const { formatProductResult } = require('../format/telegramFormatter');
const { loadLastScrape } = require('../scraper/tenderStore');
const { extractZip, listDocxAndPdfFiles } = require('../scraper/extract');
const { downloadInviteZip } = require('../scraper/download');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TENDERS_PER_PAGE = 10;

// ── In-memory session: tracks per-user "mode" (normalize / search) ───────────
// Key: userId (string), Value: 'normalize' | 'search' | null
const userSession = new Map();

// ── Main inline keyboard shown by /start and the back button ─────────────────
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Manual Scrape', 'scrape')],
    [Markup.button.callback('📋 Tender List', 'tender_list:0')],
    [Markup.button.callback('📝 Normalize DOCX', 'normalize')],
    [Markup.button.callback('🔍 Search', 'search')],
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: send or edit a message safely
// ─────────────────────────────────────────────────────────────────────────────
async function safeEditOrReply(ctx, text, extra = {}) {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...extra });
    }
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', ...extra }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register all handlers on the bot instance
// ─────────────────────────────────────────────────────────────────────────────
function registerHandlers(bot) {
  // ── /start — show main menu ────────────────────────────────────────────────
  bot.start(async (ctx) => {
    userSession.delete(String(ctx.from.id));
    await ctx.reply(
      '👋 <b>Tender Bot</b>\n\nChoose an action:',
      { parse_mode: 'HTML', ...mainMenuKeyboard() }
    );
  });

  // ── /menu — same as /start ─────────────────────────────────────────────────
  bot.command('menu', async (ctx) => {
    userSession.delete(String(ctx.from.id));
    await ctx.reply('Choose an action:', mainMenuKeyboard());
  });

  // ── Manual scrape ──────────────────────────────────────────────────────────
  bot.command('scrape', handleManualScrape);
  bot.action('scrape', handleManualScrape);

  async function handleManualScrape(ctx) {
    const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);
    if (ctx.callbackQuery) await ctx.answerCbQuery('Starting scrape…');
    await ctx.reply('🔄 <b>Manual scrape started…</b>', { parse_mode: 'HTML' });

    try {
      await runFullScrape({
        telegram: ctx.telegram,
        chatId,
        silent: true,
      });
    } catch (err) {
      logger.error('Manual scrape failed', { error: err.message });
      await ctx.reply(`❌ Scrape failed: ${err.message}`);
    }
  }

  // ── Tender List ────────────────────────────────────────────────────────────
  bot.action(/^tender_list:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1], 10) || 0;

    const lastScrape = loadLastScrape();
    if (!lastScrape || !lastScrape.tenders || lastScrape.tenders.length === 0) {
      await safeEditOrReply(ctx,
        '⚠️ No scraped tenders available yet. Run a scrape first.',
        mainMenuKeyboard());
      return;
    }

    const tenders = lastScrape.tenders;
    const totalPages = Math.ceil(tenders.length / TENDERS_PER_PAGE);
    const slice = tenders.slice(page * TENDERS_PER_PAGE, (page + 1) * TENDERS_PER_PAGE);

    let text = `📋 <b>Tender List</b> (page ${page + 1}/${totalPages})\n\n`;
    const rows = slice.map((t, i) => {
      const num = page * TENDERS_PER_PAGE + i + 1;
      return `${num}. <b>${t.name}</b>\n   📅 ${t.date || '—'}`;
    });
    text += rows.join('\n\n');

    // Build buttons: one per tender + prev/next pagination
    const tenderButtons = slice.map((t, i) => {
      const idx = page * TENDERS_PER_PAGE + i;
      return [Markup.button.callback(`📥 Download #${idx + 1}`, `tender_dl:${idx}`)];
    });

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `tender_list:${page - 1}`));
    if (page < totalPages - 1) navRow.push(Markup.button.callback('Next ➡️', `tender_list:${page + 1}`));
    if (navRow.length) tenderButtons.push(navRow);
    tenderButtons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    await safeEditOrReply(ctx, text, Markup.inlineKeyboard(tenderButtons));
  });

  // ── Download individual tender ─────────────────────────────────────────────
  bot.action(/^tender_dl:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Downloading…');
    const idx = parseInt(ctx.match[1], 10);

    const lastScrape = loadLastScrape();
    if (!lastScrape || !lastScrape.tenders || !lastScrape.tenders[idx]) {
      await ctx.reply('⚠️ Tender not found. Please refresh the tender list.');
      return;
    }

    const tender = lastScrape.tenders[idx];
    const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);

    await ctx.reply(`⏳ Downloading <b>${tender.name}</b>…`, { parse_mode: 'HTML' });

    try {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        acceptDownloads: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'hy-AM',
      });
      const page = await context.newPage();

      let zipPath = null;
      try {
        zipPath = await downloadInviteZip(page, tender.link, DOWNLOAD_DIR);
      } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      }

      if (!zipPath) {
        // Try sending the direct download link if it exists on the listing card
        if (tender.downloadLink) {
          await ctx.reply(
            `📥 Direct download link for <b>${tender.name}</b>:\n${tender.downloadLink}`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.reply(`⚠️ No download found for <b>${tender.name}</b>.`, { parse_mode: 'HTML' });
        }
        return;
      }

      // Extract the ZIP and send all files
      const extractDir = extractZip(zipPath);
      const { docx, pdf } = listDocxAndPdfFiles(extractDir);
      const allFiles = [...docx, ...pdf];

      if (!allFiles.length) {
        // Send the ZIP itself
        await ctx.telegram.sendDocument(chatId, { source: zipPath, filename: path.basename(zipPath) }, {
          caption: `📦 ${tender.name}`,
        });
        return;
      }

      // Send each extracted file
      for (const filePath of allFiles) {
        await ctx.telegram.sendDocument(chatId,
          { source: filePath, filename: path.basename(filePath) },
          { caption: `📄 ${tender.name}` }
        );
      }
    } catch (err) {
      logger.error('Tender download failed', { name: tender.name, error: err.message });
      await ctx.reply(`❌ Download failed: ${err.message}`);
    }
  });

  // ── Normalize mode ─────────────────────────────────────────────────────────
  bot.action('normalize', async (ctx) => {
    await ctx.answerCbQuery();
    userSession.set(String(ctx.from.id), 'normalize');
    await safeEditOrReply(ctx,
      '📝 <b>Normalize mode</b>\n\nSend me the raw DOCX file (hraver.docx) and I will extract its data and generate a normalized document in the standard format.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Cancel', 'main_menu')]]) }
    );
  });

  // ── Search mode ────────────────────────────────────────────────────────────
  bot.action('search', async (ctx) => {
    await ctx.answerCbQuery();
    userSession.set(String(ctx.from.id), 'search');
    await safeEditOrReply(ctx,
      '🔍 <b>Search mode</b>\n\nSend me the normalized DOCX file and I will search for matching products on the Armenian market.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Cancel', 'main_menu')]]) }
    );
  });

  // ── Main menu button ───────────────────────────────────────────────────────
  bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    userSession.delete(String(ctx.from.id));
    await safeEditOrReply(ctx, 'Choose an action:', mainMenuKeyboard());
  });

  // ── Document handler (normalize / search based on session) ────────────────
  bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const isDocx = doc.mime_type === DOCX_MIME || (doc.file_name || '').endsWith('.docx');

    if (!isDocx) {
      await ctx.reply('⚠️ Please send a .docx file.');
      return;
    }

    const sizeMb = doc.file_size / (1024 * 1024);
    if (sizeMb > config.maxFileSizeMb) {
      await ctx.reply(`❌ File too large (${sizeMb.toFixed(1)} MB). Max: ${config.maxFileSizeMb} MB.`);
      return;
    }

    const userId = String(ctx.from.id);
    const mode = userSession.get(userId) || 'search'; // default: search (original behaviour)

    if (mode === 'normalize') {
      await handleNormalize(ctx, doc);
    } else {
      // 'search' or legacy default
      await handleSearch(ctx, doc);
    }
  });

  // ── Text fallback ──────────────────────────────────────────────────────────
  bot.on('message', async (ctx) => {
    if (ctx.message.document) return; // handled above
    await ctx.reply(
      'Please use the menu buttons or upload a .docx file.',
      mainMenuKeyboard()
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalize handler
// ─────────────────────────────────────────────────────────────────────────────
async function handleNormalize(ctx, doc) {
  const statusMsg = await ctx.reply('📄 Extracting data from document…');

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const { data: rawData } = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(rawData);

    // Write to a temp file so docxDataExtractor (which uses mammoth with a path) can read it
    const tmpDir = path.join(DOWNLOAD_DIR, '_tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `tmp_${Date.now()}.docx`);
    fs.writeFileSync(tmpPath, buffer);

    let extractedData;
    try {
      const { data } = await extractDocxData(tmpPath);
      extractedData = data;
    } finally {
      fs.unlinkSync(tmpPath);
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, undefined,
      '⚙️ Generating normalized DOCX…'
    );

    const normalizedBuffer = await generateNormalizedDocx(extractedData);

    // Clear session
    userSession.delete(String(ctx.from.id));

    await ctx.telegram.sendDocument(ctx.chat.id,
      { source: normalizedBuffer, filename: `normalized_${doc.file_name || 'tender.docx'}` },
      { caption: '✅ Normalized DOCX ready.' }
    );

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, undefined,
      '✅ Done!', mainMenuKeyboard()
    );
  } catch (err) {
    logger.error('Normalize handler failed', { error: err.message });
    await ctx.reply(`❌ Failed to normalize document: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search handler (original pipeline, now accessible via button)
// ─────────────────────────────────────────────────────────────────────────────
async function handleSearch(ctx, doc) {
  const statusMsg = await ctx.reply('📄 Reading the document…');

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const { data: rawData } = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(rawData);

    const { products, warnings, results } = await runPipeline(buffer);

    for (const w of warnings) {
      await ctx.reply(`⚠️ ${w}`);
    }

    if (!products.length) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, undefined,
        '⚠️ No product rows with technical specifications found in this document.'
      );
      return;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, undefined,
      `📄 Found ${products.length} product(s). Searching the market for each…`
    );

    for (const r of results) {
      if (r.error) {
        await ctx.reply(
          `❌ Product "${r.product.name}": search error (${r.error}). Skipped.`
        );
        continue;
      }
      const text = formatProductResult(r.product, r.result);
      try {
        await ctx.replyWithMarkdownV2(text, { disable_web_page_preview: false });
      } catch {
        const plain = text
          .replace(/\\([_*[\]()~`>#+=|{}.!\\\-])/g, '$1')
          .replace(/[*_~`]/g, '');
        await ctx.reply(plain);
      }
    }

    // Clear session
    userSession.delete(String(ctx.from.id));

    await ctx.reply('✅ Search complete.', mainMenuKeyboard());
  } catch (err) {
    logger.error('Search handler failed', { error: err.message });
    await ctx.reply(
      '❌ Something went wrong while processing the file. Please try again.'
    );
  }
}

module.exports = { registerHandlers, mainMenuKeyboard };
