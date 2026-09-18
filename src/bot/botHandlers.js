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
 *  - callback: "extract_specs"  → Prompt user to send a tender ZIP to extract attached specs
 *
 * Document messages are also handled here when the bot is in "normalize",
 * "search", or "extract_specs" session mode (tracked per-user via a lightweight in-memory session).
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
const { formatExaResult } = require('../format/exaFormatter');
const { loadLastScrape } = require('../scraper/tenderStore');
const { extractZip, listDocxAndPdfFiles } = require('../scraper/extract');
const { downloadInviteZip } = require('../scraper/download');
const { processZipForSpecs } = require('./zipSpecExtractor');
const { registerProcurementHandlers } = require('./procurementHandlers');


const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TENDERS_PER_PAGE = 10;

// ── In-memory session: tracks per-user "mode" (normalize / search) ───────────
// Key: userId (string), Value: 'normalize' | 'search' | null
const userSession = new Map();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Persistent reply keyboard shown by /start, /menu, and completion messages ─
function mainMenuKeyboard() {
  return Markup.keyboard([
    ['🔄 Manual Scrape', '📋 Tender List'],
    ['📝 Normalize DOCX', '🔍 Search'],
    ['📦 Extract Specs (ZIP)', 'Գնումներ'],
  ]).resize().persistent();
}


// ─────────────────────────────────────────────────────────────────────────────
// Helper: send or edit a message safely with HTML fallback
// ─────────────────────────────────────────────────────────────────────────────
async function safeEditOrReply(ctx, text, extra = {}) {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...extra });
    }
  } catch (err) {
    logger.warn('safeEditOrReply failed with HTML, retrying plain text', { error: err.message });
    try {
      const plain = text.replace(/<[^>]+>/g, '');
      if (ctx.callbackQuery) {
        await ctx.editMessageText(plain, extra);
      } else {
        await ctx.reply(plain, extra);
      }
    } catch (fallbackErr) {
      logger.error('safeEditOrReply plain fallback also failed', { error: fallbackErr.message });
      await ctx.reply('Action complete. Please select an option:', mainMenuKeyboard()).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register all handlers on the bot instance
// ─────────────────────────────────────────────────────────────────────────────
function registerHandlers(bot) {
  // ── /start — show the persistent main menu keyboard ───────────────────────
  bot.start(async (ctx) => {
    userSession.delete(String(ctx.from?.id || ctx.chat?.id));
    await ctx.reply('👋 <b>Tender Bot</b>\n\nChoose an action using the inline buttons below:', {
      parse_mode: 'HTML',
      ...mainMenuKeyboard(),
    });
  });

  // ── /menu — show the persistent main menu keyboard ─────────────────────────
  bot.command('menu', async (ctx) => {
    userSession.delete(String(ctx.from?.id || ctx.chat?.id));
    await ctx.reply('Choose an action:', {
      parse_mode: 'HTML',
      ...mainMenuKeyboard(),
    });
  });

  // ── Text triggers (handles old reply buttons & typed commands) ──────────────
  bot.hears(['🔄 Manual Scrape', 'Manual Scrape', 'Manual scrape'], async (ctx) => {
    await ctx.reply('🔄 Starting scrape…', Markup.removeKeyboard()).catch(() => {});
    return handleManualScrape(ctx);
  });
  bot.hears(['📋 Tender List', 'Tender List', 'Tender list', '/list'], async (ctx) => {
    await ctx.reply('📋 Loading tender list…', Markup.removeKeyboard()).catch(() => {});
    return handleTenderList(ctx);
  });
  bot.hears(['📝 Normalize DOCX', 'Normalize DOCX', 'Normalize docx', '/normalize'], async (ctx) => {
    await ctx.reply('📝 Normalize mode selected', Markup.removeKeyboard()).catch(() => {});
    return handleNormalizePrompt(ctx);
  });
  bot.hears(['🔍 Search', 'Search', 'search'], async (ctx) => {
    await ctx.reply('🔍 Search mode selected', Markup.removeKeyboard()).catch(() => {});
    return handleSearchPrompt(ctx);
  });
  bot.hears([
    '📦 Extract Specs (ZIP)',
    'Extract Specs (ZIP)',
    '📦 Extract Attached Specs',
    'Extract Attached Specs',
    'Extract Specs',
    '/extract_specs',
    '/specs',
  ], async (ctx) => {
    await ctx.reply('📦 Extract specs mode selected', Markup.removeKeyboard()).catch(() => {});
    return handleExtractSpecsPrompt(ctx);
  });

  // ── Գնումներ button ──────────────────────────────────────────────────────────
  bot.hears(['Գնումներ', '🛒 Գնումներ', '/procurement', '/gnumner'], async (ctx) => {
    await ctx.reply('🛒 <b>Գնումներ</b>\n\nԸնտրեք բաժինը՝', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Ընթացիկ', 'proc:current')],
        [Markup.button.callback('Ժամկետանց', 'proc:overdue')],
        [Markup.button.callback('Մոնիթորինգ', 'proc:monitoring')],
      ]),
    });
  });

  // ── Manual scrape ──────────────────────────────────────────────────────────
  bot.command('scrape', handleManualScrape);
  bot.action('scrape', handleManualScrape);

  async function handleManualScrape(ctx) {
    const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);
    if (ctx.callbackQuery) await ctx.answerCbQuery('Starting scrape…').catch(() => {});
    await ctx.reply('🔄 <b>Manual scrape started…</b>', { parse_mode: 'HTML' });

    try {
      await runFullScrape({
        telegram: ctx.telegram,
        chatId,
        silent: true,
      });
    } catch (err) {
      logger.error('Manual scrape failed', { error: err.message });
      await ctx.reply(`❌ Scrape failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  }

  // ── Tender List ────────────────────────────────────────────────────────────
  bot.action(/^tender_list(?::(\d+))?$/, handleTenderList);

  async function handleTenderList(ctx) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const pageMatch = ctx.match && ctx.match[1];
    const page = pageMatch ? parseInt(pageMatch, 10) : 0;

    const lastScrape = loadLastScrape();
    if (!lastScrape || !lastScrape.tenders || lastScrape.tenders.length === 0) {
      await safeEditOrReply(ctx,
        '⚠️ No scraped tenders available yet. Run a scrape first.',
        mainMenuKeyboard());
      return;
    }

    const tenders = lastScrape.tenders;
    const totalPages = Math.ceil(tenders.length / TENDERS_PER_PAGE);
    const validPage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = tenders.slice(validPage * TENDERS_PER_PAGE, (validPage + 1) * TENDERS_PER_PAGE);

    let text = `📋 <b>Tender List</b> (page ${validPage + 1}/${totalPages})\n\n`;
    const rows = slice.map((t, i) => {
      const num = validPage * TENDERS_PER_PAGE + i + 1;
      const dateStr = t.date ? escapeHtml(t.date) : '—';
      return `${num}. <b>${escapeHtml(t.name)}</b>\n   📅 ${dateStr}`;
    });
    text += rows.join('\n\n');

    // Build inline buttons: one per tender to download/extract + prev/next pagination
    const tenderButtons = slice.map((t, i) => {
      const idx = validPage * TENDERS_PER_PAGE + i;
      const num = idx + 1;
      const shortName = t.name.length > 30 ? t.name.slice(0, 27) + '…' : t.name;
      return [Markup.button.callback(`📥 #${num} ${shortName}`, `tender_dl:${idx}`)];
    });

    const navRow = [];
    if (validPage > 0) navRow.push(Markup.button.callback('⬅️ Prev', `tender_list:${validPage - 1}`));
    if (validPage < totalPages - 1) navRow.push(Markup.button.callback('Next ➡️', `tender_list:${validPage + 1}`));
    if (navRow.length) tenderButtons.push(navRow);
    tenderButtons.push([Markup.button.callback('🏠 Main Menu', 'main_menu')]);

    await safeEditOrReply(ctx, text, Markup.inlineKeyboard(tenderButtons));
  }

  // ── Download & extract individual tender ───────────────────────────────────
  bot.action(/^tender_dl:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Downloading…').catch(() => {});
    const idx = parseInt(ctx.match[1], 10);

    const lastScrape = loadLastScrape();
    if (!lastScrape || !lastScrape.tenders || !lastScrape.tenders[idx]) {
      await ctx.reply('⚠️ Tender not found. Please refresh the tender list.');
      return;
    }

    const tender = lastScrape.tenders[idx];
    const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);
    const tenderUrl = tender.link;

    if (!tenderUrl) {
      await ctx.reply(`⚠️ No download URL found for <b>${escapeHtml(tender.name)}</b>.`, { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(`⏳ Downloading <b>${escapeHtml(tender.name)}</b>…`, { parse_mode: 'HTML' });

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
        zipPath = await downloadInviteZip(page, tenderUrl, DOWNLOAD_DIR);
      } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      }

      if (!zipPath) {
        await ctx.reply(
          `⚠️ No ZIP download found for <b>${escapeHtml(tender.name)}</b>.\n🔗 <a href="${tenderUrl}">Open tender page</a>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Extract the ZIP and send all files
      const extractDir = extractZip(zipPath);
      const { docx, pdf } = listDocxAndPdfFiles(extractDir);
      let allFiles = [...docx, ...pdf];

      if (!allFiles.length) {
        // Collect any files in extractDir
        const walkAll = (dir) => {
          let res = [];
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) res.push(...walkAll(full));
            else if (entry.isFile()) res.push(full);
          }
          return res;
        };
        allFiles = walkAll(extractDir);
      }

      if (!allFiles.length) {
        // Send the ZIP itself
        await ctx.telegram.sendDocument(chatId, { source: zipPath, filename: path.basename(zipPath) }, {
          caption: `📦 ${tender.name.slice(0, 200)}`,
        });
        return;
      }

      // Send each extracted file with retry logic
      for (const filePath of allFiles) {
        let sent = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await ctx.telegram.sendDocument(chatId,
              { source: filePath, filename: path.basename(filePath) },
              { caption: `📄 ${tender.name.slice(0, 200)}` }
            );
            sent = true;
            break;
          } catch (uploadErr) {
            logger.warn(`sendDocument attempt ${attempt} failed for ${filePath}: ${uploadErr.message}`);
            if (attempt === 3) throw uploadErr;
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      }
    } catch (err) {
      logger.error('Tender download failed', { name: tender.name, error: err.message });
      await ctx.reply(`❌ Download failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  // ── Normalize mode ─────────────────────────────────────────────────────────
  bot.action('normalize', handleNormalizePrompt);

  async function handleNormalizePrompt(ctx) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = String(ctx.from?.id || ctx.chat?.id);
    userSession.set(userId, 'normalize');
    await safeEditOrReply(ctx,
      '📝 <b>Normalize mode</b>\n\nSend me the raw DOCX file (hraver.docx) and I will extract its data and generate a normalized document in the standard format.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Cancel', 'main_menu')]]) }
    );
  }

  // ── Search mode ────────────────────────────────────────────────────────────
  bot.action('search', handleSearchPrompt);

  async function handleSearchPrompt(ctx) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = String(ctx.from?.id || ctx.chat?.id);
    userSession.set(userId, 'search');
    await safeEditOrReply(ctx,
      '🔍 <b>Search mode</b>\n\nSend me the normalized DOCX file and I will search for matching products on the Armenian market.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Cancel', 'main_menu')]]) }
    );
  }

  // ── Extract specs mode ─────────────────────────────────────────────────────
  bot.command(['specs', 'extract_specs'], handleExtractSpecsPrompt);
  bot.action('extract_specs', handleExtractSpecsPrompt);

  async function handleExtractSpecsPrompt(ctx) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = String(ctx.from?.id || ctx.chat?.id);
    userSession.set(userId, 'extract_specs');
    await safeEditOrReply(ctx,
      '📦 <b>Extract Specs mode</b>\n\nSend me a tender ZIP file. I will look for <code>hraver.docx</code>, check if technical specifications refer to attached files (<code>կից</code> / <code>կցված</code>), and extract all matching specification files for you.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Cancel', 'main_menu')]]) }
    );
  }

  // ── Main menu button ───────────────────────────────────────────────────────
  bot.action('main_menu', async (ctx) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const userId = String(ctx.from?.id || ctx.chat?.id);
    userSession.delete(userId);
    await safeEditOrReply(ctx, 'Choose an action:', mainMenuKeyboard());
  });

  // ── Document handler (normalize / search / extract_specs based on session) ──
  bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const fileName = (doc.file_name || '').toLowerCase();
    const isDocx = doc.mime_type === DOCX_MIME || fileName.endsWith('.docx');
    const isZip = fileName.endsWith('.zip') ||
      doc.mime_type === 'application/zip' ||
      doc.mime_type === 'application/x-zip-compressed' ||
      (doc.mime_type === 'application/octet-stream' && fileName.endsWith('.zip'));

    const userId = String(ctx.from?.id || ctx.chat?.id);
    const mode = userSession.get(userId) || (isZip ? 'extract_specs' : 'search');

    if (mode === 'extract_specs') {
      if (!isZip) {
        await ctx.reply('⚠️ Please send a .zip file.');
        return;
      }
    } else {
      if (!isDocx) {
        await ctx.reply('⚠️ Please send a .docx file.');
        return;
      }
    }

    const sizeMb = doc.file_size / (1024 * 1024);
    if (sizeMb > config.maxFileSizeMb) {
      await ctx.reply(`❌ File too large (${sizeMb.toFixed(1)} MB). Max: ${config.maxFileSizeMb} MB.`);
      return;
    }

    if (mode === 'extract_specs') {
      await handleExtractSpecs(ctx, doc);
    } else if (mode === 'normalize') {
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
      'Please use the menu buttons or upload a .docx or .zip file.',
      mainMenuKeyboard()
    );
  });

  // ── Procurement handlers ───────────────────────────────────────────────────
  registerProcurementHandlers(bot);
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

    // Send document with retry to handle intermittent socket hang ups on cloud hosts
    const outFilename = `normalized_${doc.file_name || 'tender.docx'}`;
    let sent = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ctx.telegram.sendDocument(
          ctx.chat.id,
          { source: normalizedBuffer, filename: outFilename },
          { caption: '✅ Normalized DOCX ready.' }
        );
        sent = true;
        break;
      } catch (uploadErr) {
        logger.warn(`sendDocument attempt ${attempt} failed: ${uploadErr.message}`);
        if (attempt === 3) throw uploadErr;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    if (sent) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, undefined,
        '✅ Done!', mainMenuKeyboard()
      ).catch(() => {});
    }
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
      const isExa = config.productSearchProvider === 'exa';
      const text = isExa
        ? formatExaResult(r.product, r.result)
        : formatProductResult(r.product, r.result);
      try {
        if (isExa) {
          await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: false });
        } else {
          await ctx.replyWithMarkdownV2(text, { disable_web_page_preview: false });
        }
      } catch {
        const plain = isExa
          ? text.replace(/<[^>]+>/g, '')
          : text.replace(/\\([_*[\]()~`>#+=|{}.!\\\-])/g, '$1').replace(/[*_~`]/g, '');
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

// ─────────────────────────────────────────────────────────────────────────────
// Extract specs handler (extract ZIP, inspect hraver.docx, send matching files)
// ─────────────────────────────────────────────────────────────────────────────
async function handleExtractSpecs(ctx, doc) {
  const statusMsg = await ctx.reply('📦 Downloading and extracting ZIP archive…');
  const userId = String(ctx.from?.id || ctx.chat?.id);
  const chatId = String(ctx.chat?.id);

  const tmpDir = path.join(DOWNLOAD_DIR, '_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const uniquePrefix = `zip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const workDir = path.join(tmpDir, uniquePrefix);
  fs.mkdirSync(workDir, { recursive: true });

  const rawBaseName = path.basename(doc.file_name || 'archive.zip');
  const safeZipName = rawBaseName.toLowerCase().endsWith('.zip') ? rawBaseName : `${rawBaseName}.zip`;
  const zipPath = path.join(workDir, safeZipName);
  let extractedDir = null;

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const { data: rawData } = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    fs.writeFileSync(zipPath, Buffer.from(rawData));

    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      '⚙️ Checking hraver.docx for attached technical specifications…'
    ).catch(() => {});

    const result = await processZipForSpecs(zipPath);
    extractedDir = result.extractedDir;

    // Clear session
    userSession.delete(userId);

    if (!result.success) {
      const errorText = result.message || 'Could not find matching specifications in this archive.';
      await ctx.telegram.editMessageText(
        chatId, statusMsg.message_id, undefined,
        `⚠️ ${escapeHtml(errorText)}`
      ).catch(() => {});
      await ctx.reply('Please choose an action:', mainMenuKeyboard());
      return;
    }

    const { matchingFiles, matchingFilesWithSpecs } = result;
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `📄 Found ${matchingFiles.length} matching specification file(s). Sending…`
    ).catch(() => {});

    for (const { filePath, techSpecs } of matchingFilesWithSpecs) {
      const fileName = path.basename(filePath);

      // Send the extracted Տեխնիկական բնութագիր values as a text message first
      if (techSpecs && techSpecs.length > 0) {
        const specsText =
          `📋 <b>${escapeHtml(fileName)}</b> — Տեխնիկական բնութագիր (${techSpecs.length} row${techSpecs.length !== 1 ? 's' : ''}):\n\n` +
          techSpecs
            .map((spec, i) => `<b>${i + 1}.</b> ${escapeHtml(spec)}`)
            .join('\n\n');

        // Telegram message limit is 4096 chars; split if needed
        const MAX_LEN = 4000;
        if (specsText.length <= MAX_LEN) {
          await ctx.reply(specsText, { parse_mode: 'HTML' }).catch((err) => {
            logger.warn('Failed to send tech specs text message', { fileName, error: err.message });
          });
        } else {
          // Send in chunks, each chunk stays under the limit
          let chunk = `📋 <b>${escapeHtml(fileName)}</b> — Տեխնիկական բնութագիր:\n\n`;
          for (let i = 0; i < techSpecs.length; i++) {
            const line = `<b>${i + 1}.</b> ${escapeHtml(techSpecs[i])}\n\n`;
            if (chunk.length + line.length > MAX_LEN) {
              await ctx.reply(chunk.trim(), { parse_mode: 'HTML' }).catch((err) => {
                logger.warn('Failed to send tech specs chunk', { fileName, error: err.message });
              });
              chunk = '';
            }
            chunk += line;
          }
          if (chunk.trim()) {
            await ctx.reply(chunk.trim(), { parse_mode: 'HTML' }).catch((err) => {
              logger.warn('Failed to send last tech specs chunk', { fileName, error: err.message });
            });
          }
        }
      }

      // Send the file itself
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await ctx.telegram.sendDocument(
            chatId,
            { source: filePath, filename: fileName },
            { caption: `📄 ${fileName}` }
          );
          break;
        } catch (uploadErr) {
          logger.warn(`sendDocument attempt ${attempt} failed for ${filePath}: ${uploadErr.message}`);
          if (attempt === 3) throw uploadErr;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }

    await ctx.reply('✅ All matching specification files sent.', mainMenuKeyboard());

  } catch (err) {
    logger.error('Extract specs handler failed', { error: err.message, stack: err.stack });
    userSession.delete(userId);
    await ctx.reply(`❌ Failed to extract specifications: ${escapeHtml(err.message)}`, mainMenuKeyboard());
  } finally {
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      logger.warn('Failed to cleanup temp extraction files', { error: cleanupErr.message });
    }
  }
}

module.exports = { registerHandlers, mainMenuKeyboard };
