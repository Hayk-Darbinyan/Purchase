'use strict';

/**
 * Telegram bot handlers for the Գնումներ (Procurement) flow.
 *
 * Menu hierarchy:
 *   Գնումներ (main reply button)
 *     └── Inline buttons:
 *           ├── Ընթացիկ
 *           │     ├── Ակտուալ (deadline ≤ 5 days)
 *           │     │     ├── մինչև 1.000.000
 *           │     │     ├── մինչև 10.000.000
 *           │     │     ├── մինչև 85.000.000
 *           │     │     ├── 85.000.000 ավել
 *           │     │     └── Տեսնել բոլորը
 *           │     └── Սպասվող (deadline > 5 days)
 *           │           ├── մինչև 1.000.000
 *           │           ├── մինչև 10.000.000
 *           │           ├── մինչև 85.000.000
 *           │           ├── 85.000.000 ավել
 *           │           └── Տեսնել բոլորը
 *           ├── Ժամկետանց (deadline passed)
 *           └── Մոնիթորինգ
 */

const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');

const logger = require('../logger');
const {
  getAllTenders,
  getTenderById,
  PRICE_RANGES,
  priceRangeFor,
  daysUntilDeadline,
  isOverdue,
} = require('../procurement/procurementStore');
const { markTenderSubmitted } = require('../procurement/deadlineNotifier');

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(val) {
  if (val == null || isNaN(val)) return '—';
  return val.toLocaleString('hy-AM').replace(/,/g, '.') + ' ֏';
}

async function safeAnswerCbQuery(ctx, text = '') {
  try {
    await ctx.answerCbQuery(text);
  } catch (_) {}
}

async function safeEditOrReply(ctx, text, extra = {}) {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...extra });
    }
  } catch (err) {
    logger.warn('safeEditOrReply (procurement) failed with HTML, retrying plain', {
      error: err.message,
    });
    try {
      const plain = text.replace(/<[^>]+>/g, '');
      if (ctx.callbackQuery) {
        await ctx.editMessageText(plain, extra);
      } else {
        await ctx.reply(plain, extra);
      }
    } catch (fallbackErr) {
      logger.error('safeEditOrReply plain fallback failed', { error: fallbackErr.message });
    }
  }
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function filterByRange(tenders, rangeKey) {
  if (rangeKey === 'all') return tenders;
  return tenders.filter((t) => {
    const r = priceRangeFor(t.price);
    return r && r.key === rangeKey;
  });
}

/** Ակտուալ — submission deadline within the next 5 days (0..5 days) */
function getAktualTenders(all) {
  return all.filter((t) => {
    if (t.submittedAt) return false;
    const d = daysUntilDeadline(t.endDate);
    return d !== null && d >= 0 && d <= 5;
  });
}

/** Սպասվող — submission deadline more than 5 days away */
function getSpasvoxTenders(all) {
  return all.filter((t) => {
    if (t.submittedAt) return false;
    const d = daysUntilDeadline(t.endDate);
    return d !== null && d > 5;
  });
}

/** Ժամկետանց — deadline passed */
function getOverdueTenders(all) {
  return all.filter((t) => {
    const d = daysUntilDeadline(t.endDate);
    return (d !== null && d < 0) || isOverdue(t.endDate);
  });
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

function priceRangeKeyboard(prefix) {
  const rows = PRICE_RANGES.map((r) => [
    Markup.button.callback(r.label, `${prefix}:${r.key}`),
  ]);
  rows.push([Markup.button.callback('Տեսնել բոլորը', `${prefix}:all`)]);
  rows.push([Markup.button.callback('⬅️ Հետ', 'proc:current')]);
  rows.push([Markup.button.callback('🏠 Գլխավոր մենյու', 'main_menu')]);
  return Markup.inlineKeyboard(rows);
}

// ── Sending Normalized DOCX Files ─────────────────────────────────────────────

async function sendNormalizedDocx(telegram, chatId, tender) {
  if (!tender.normalizedDocxPath || !fs.existsSync(tender.normalizedDocxPath)) {
    return false;
  }
  const filename = path.basename(tender.normalizedDocxPath);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await telegram.sendDocument(
        chatId,
        { source: tender.normalizedDocxPath, filename },
        {
          caption: `📄 Նորմալիզացված ֆայլ՝\n<b>${escapeHtml(tender.name.slice(0, 200))}</b>`,
          parse_mode: 'HTML',
        }
      );
      return true;
    } catch (err) {
      if (attempt === 3) {
        logger.error('Failed to send normalized docx', { path: tender.normalizedDocxPath, error: err.message });
        return false;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return false;
}

// ── Display Tender Details ────────────────────────────────────────────────────

async function sendTenderDetail(ctx, tender) {
  const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);
  const days = daysUntilDeadline(tender.endDate);
  const daysStr =
    days === null
      ? '—'
      : days < 0
      ? 'ժամկետանց'
      : days === 0
      ? 'այսօր'
      : `${days} օր`;

  const text =
    `📋 <b>${escapeHtml(tender.name)}</b>\n\n` +
    `💰 Գին՝ <b>${formatPrice(tender.price)}</b>\n` +
    `📅 Հրապարակման ամսաթիվ՝ <b>${escapeHtml(tender.startDate || tender.date || '—')}</b>\n` +
    `⏰ Ներկայացման վերջնաժամկետ՝ <b>${escapeHtml(tender.endDate || '—')}</b>\n` +
    `⏳ Մնացել է՝ <b>${daysStr}</b>\n` +
    (tender.submittedAt ? `\n✅ <i>Հայտը ներկայացված/բեռնված է (${escapeHtml(tender.submittedAt.slice(0, 10))})</i>` : '');

  const buttons = [];
  if (!tender.submittedAt) {
    buttons.push([
      Markup.button.callback('✅ Հայտը բեռնված է', `proc:submitted:${tender.id}`),
    ]);
  }
  if (tender.link) {
    buttons.push([Markup.button.url('🔗 Բացել հայտարարությունը', tender.link)]);
  }
  buttons.push([Markup.button.callback('⬅️ Հետ դեպի Գնումներ', 'procurement')]);

  await safeEditOrReply(ctx, text, Markup.inlineKeyboard(buttons));

  // Send existing normalized DOCX file
  if (tender.normalizedDocxPath && fs.existsSync(tender.normalizedDocxPath)) {
    await sendNormalizedDocx(ctx.telegram, chatId, tender);
  }
}

// ── Render Tenders List ───────────────────────────────────────────────────────

async function handleCategoryTenders(ctx, tenders, title, backCallback) {
  const chatId = String(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);

  if (!tenders.length) {
    await safeEditOrReply(
      ctx,
      `${title}\n\n⚠️ <i>Համապատասխան գնումներ չեն գտնվել:</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Հետ', backCallback)],
        [Markup.button.callback('🏠 Գլխավոր մենյու', 'main_menu')],
      ])
    );
    return;
  }

  let messageText = `${title}\n\nԳտնվել է <b>${tenders.length}</b> գնում՝\n\n`;

  const rows = tenders.map((t, i) => {
    const days = daysUntilDeadline(t.endDate);
    const daysStr =
      days === null ? '—' : days < 0 ? 'ժամկետանց' : days === 0 ? 'այսօր' : `${days} օր`;
    return (
      `<b>${i + 1}. ${escapeHtml(t.name.slice(0, 90))}${t.name.length > 90 ? '…' : ''}</b>\n` +
      `   💰 Գին՝ <b>${formatPrice(t.price)}</b>\n` +
      `   📅 Վերջնաժամկետ՝ ${escapeHtml(t.endDate || '—')} (մնացել է՝ ${daysStr})\n` +
      (t.submittedAt ? `   ✅ <i>Հայտը բեռնված է</i>\n` : '')
    );
  });

  messageText += rows.join('\n');

  const inlineButtons = tenders.map((t, i) => {
    const short = t.name.length > 30 ? t.name.slice(0, 27) + '…' : t.name;
    return [Markup.button.callback(`📄 #${i + 1} ${short}`, `proc:tender:${t.id}`)];
  });

  inlineButtons.push([Markup.button.callback('⬅️ Հետ', backCallback)]);
  inlineButtons.push([Markup.button.callback('🏠 Գլխավոր մենյու', 'main_menu')]);

  await safeEditOrReply(ctx, messageText, Markup.inlineKeyboard(inlineButtons));

  // Requirement: "show the matching tenders and their normalized DOCX files"
  // For each matching tender with a normalized DOCX, send the file
  for (const t of tenders) {
    if (t.normalizedDocxPath && fs.existsSync(t.normalizedDocxPath)) {
      await sendNormalizedDocx(ctx.telegram, chatId, t);
    }
  }
}

// ── Handler Registration ──────────────────────────────────────────────────────

function registerProcurementHandlers(bot) {
  // ── Գնումներ main menu ─────────────────────────────────────────────────────
  bot.action('procurement', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEditOrReply(
      ctx,
      '🛒 <b>Գնումներ</b>\n\nԸնտրեք բաժինը՝',
      Markup.inlineKeyboard([
        [Markup.button.callback('Ընթացիկ', 'proc:current')],
        [Markup.button.callback('Ժամկետանց', 'proc:overdue')],
        [Markup.button.callback('Մոնիթորինգ', 'proc:monitoring')],
        [Markup.button.callback('🏠 Գլխավոր մենյու', 'main_menu')],
      ])
    );
  });

  // ── Ընթացիկ → Ակտուալ / Սպասվող ─────────────────────────────────────────────
  bot.action('proc:current', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEditOrReply(
      ctx,
      '📂 <b>Ընթացիկ գնումներ</b>\n\nԸնտրեք տեսակը՝',
      Markup.inlineKeyboard([
        [Markup.button.callback('Ակտուալ', 'proc:current:aktual')],
        [Markup.button.callback('Սպասվող', 'proc:current:spasvox')],
        [Markup.button.callback('⬅️ Հետ', 'procurement')],
      ])
    );
  });

  // ── Ակտուալ — pick price range ──────────────────────────────────────────────
  bot.action('proc:current:aktual', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEditOrReply(
      ctx,
      '🔥 <b>Ակտուալ գնումներ</b> (վերջնաժամկետը՝ առաջիկա 5 օրերի ընթացքում)\n\nԸնտրեք գնային միջակայքը՝',
      priceRangeKeyboard('proc:current:aktual')
    );
  });

  // ── Սպասվող — pick price range ─────────────────────────────────────────────
  bot.action('proc:current:spasvox', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEditOrReply(
      ctx,
      '⏳ <b>Սպասվող գնումներ</b> (վերջնաժամկետին մնացել է 5-ից ավելի օր)\n\nԸնտրեք գնային միջակայքը՝',
      priceRangeKeyboard('proc:current:spasvox')
    );
  });

  // ── Ակտուալ + Price range (or all) ─────────────────────────────────────────
  bot.action(/^proc:current:aktual:(r\d|all)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const rangeKey = ctx.match[1];
    const all = getAllTenders();
    const aktual = getAktualTenders(all);
    const filtered = filterByRange(aktual, rangeKey);

    const rangeObj = PRICE_RANGES.find((r) => r.key === rangeKey);
    const label = rangeKey === 'all' ? 'Տեսնել բոլորը' : (rangeObj ? rangeObj.label : rangeKey);

    await handleCategoryTenders(
      ctx,
      filtered,
      `🔥 <b>Ակտուալ գնումներ — ${escapeHtml(label)}</b>`,
      'proc:current:aktual'
    );
  });

  // ── Սպասվող + Price range (or all) ─────────────────────────────────────────
  bot.action(/^proc:current:spasvox:(r\d|all)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const rangeKey = ctx.match[1];
    const all = getAllTenders();
    const spasvox = getSpasvoxTenders(all);
    const filtered = filterByRange(spasvox, rangeKey);

    const rangeObj = PRICE_RANGES.find((r) => r.key === rangeKey);
    const label = rangeKey === 'all' ? 'Տեսնել բոլորը' : (rangeObj ? rangeObj.label : rangeKey);

    await handleCategoryTenders(
      ctx,
      filtered,
      `⏳ <b>Սպասվող գնումներ — ${escapeHtml(label)}</b>`,
      'proc:current:spasvox'
    );
  });

  // ── Ժամկետանց ─────────────────────────────────────────────────────────────
  bot.action('proc:overdue', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const all = getAllTenders();
    const overdue = getOverdueTenders(all);

    await handleCategoryTenders(
      ctx,
      overdue,
      '⚠️ <b>Ժամկետանց գնումներ</b>',
      'procurement'
    );
  });

  // ── Մոնիթորինգ ────────────────────────────────────────────────────────────
  bot.action('proc:monitoring', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEditOrReply(
      ctx,
      '📊 <b>Մոնիթորինգ</b>\n\nԲաժինը գտնվում է մշակման փուլում:',
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Հետ', 'procurement')],
        [Markup.button.callback('🏠 Գլխավոր մենյու', 'main_menu')],
      ])
    );
  });

  // ── Single Tender Details ──────────────────────────────────────────────────
  bot.action(/^proc:tender:(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx, 'Բացվում է…');
    const id = ctx.match[1];
    const tender = getTenderById(id);
    if (!tender) {
      await ctx.reply('⚠️ Գնումը չի գտնվել:');
      return;
    }
    await sendTenderDetail(ctx, tender);
  });

  // ── Mark as Submitted ──────────────────────────────────────────────────────
  bot.action(/^proc:submitted:(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx, 'Գրանցվում է…');
    const id = ctx.match[1];
    const ok = markTenderSubmitted(id);

    if (ok) {
      await ctx.reply(
        '✅ <b>Հայտը նշված է որպես բեռնված/ներկայացված:</b>\nԱյս գնման համար ժամկետի հիշեցումներ այլևս չեն ուղարկվի:',
        { parse_mode: 'HTML' }
      );
      try {
        if (ctx.callbackQuery?.message) {
          const currentText = ctx.callbackQuery.message.text || '';
          await ctx.editMessageText(
            currentText + `\n\n✅ <i>Հայտը բեռնված է</i>`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (_) {}
    } else {
      await ctx.reply('⚠️ Գնումը չի գտնվել:');
    }
  });
}

module.exports = { registerProcurementHandlers };
