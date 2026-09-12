const { Telegraf } = require("telegraf");
const { config, assertReadyForBot } = require("./config");
const logger = require("./logger");
const { registerHandlers } = require("./bot/botHandlers");
const { startScheduler } = require("./scheduler");
const http = require("http");

assertReadyForBot();

const bot = new Telegraf(config.telegramBotToken);

// ── Register all bot handlers (buttons, commands, document uploads) ──────────
registerHandlers(bot);

// ── Global error handler ─────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  logger.error("Unhandled bot error", { error: err.message });
  ctx.reply("An unexpected error occurred. Please try again.").catch(() => {});
});

// ── Start the bot ────────────────────────────────────────────────────────────
bot.launch().then(() => {
  logger.info("Bot started");

  // Start daily scrape scheduler (09:30 Armenia time / 05:30 UTC)
  // Notifications go to NOTIFY_CHAT_ID (or silently if not set)
  startScheduler({
    telegram: bot.telegram,
    chatId: config.notifyChatId || null,
  });
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

const PORT = process.env.PORT || 3000;

const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

healthServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`HTTP health server listening on port ${PORT}`);
});