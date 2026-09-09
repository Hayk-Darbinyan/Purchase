require("dotenv").config();

function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",

  armenianStoreDomains: parseList(process.env.ARMENIAN_STORE_DOMAINS, [
    "redstore.am",
    "yerevanmobile.am",
    "vega.am",
    "alfa.am",
    "digital.am",
  ]),

  armenianMatchMinConfidence: Number(
    process.env.ARMENIAN_MATCH_MIN_CONFIDENCE || 0.5
  ),

  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 15),

  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3-flash",

  logLevel: process.env.LOG_LEVEL || "info",
};

function assertReadyForBot() {
  const missing = [];
  if (!config.telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(
        ", "
      )}. Copy .env.example to .env and fill them in.`
    );
  }
}

module.exports = { config, assertReadyForBot };
