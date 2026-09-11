require("dotenv").config();

const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  serpApiKey: process.env.SERPAPI_API_KEY || "",
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 15),
  logLevel: process.env.LOG_LEVEL || "info",
};

function assertReadyForBot() {
  const missing = [];
  if (!config.telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.serpApiKey) missing.push("SERPAPI_API_KEY");
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(
        ", ",
      )}. Copy .env.example to .env and fill them in.`,
    );
  }
}

module.exports = { config, assertReadyForBot };

