const { Telegraf } = require("telegraf");
const { config, assertReadyForBot } = require("./config");
const logger = require("./logger");
const { registerHandlers } = require("./bot/botHandlers");
const { startScheduler } = require("./scheduler");
const http = require("http");

const https = require("https");

assertReadyForBot();

// Cloud platforms (Render, Heroku, AWS) can close idle TCP connections,
// causing 'socket hang up' on file uploads. Configure robust HTTPS agent.
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  timeout: 60000,
  noDelay: true,
});

const bot = new Telegraf(config.telegramBotToken, {
  telegram: {
    agent: httpsAgent,
    attachmentAgent: httpsAgent,
  },
});

// ── Register all bot handlers (buttons, commands, document uploads) ──────────
registerHandlers(bot);

// ── Global error handler ─────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  logger.error("Unhandled bot error", { error: err.message });
  ctx.reply("An unexpected error occurred. Please try again.").catch(() => {});
});

// ── Start schedulers and the bot ─────────────────────────────────────────────
// Scheduler initialization must not wait for Telegram polling to resolve.
startScheduler({
  telegram: bot.telegram,
  chatId: config.notifyChatId || null,
});

bot.launch()
  .then(() => {
    logger.info("Bot started");
  })
  .catch((err) => {
    logger.error("Bot failed to start", { error: err.message });
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