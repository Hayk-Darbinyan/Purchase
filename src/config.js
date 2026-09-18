require("dotenv").config();

const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  serpApiKey: process.env.SERPAPI_API_KEY || "",
  exaApiKey: process.env.EXA_API_KEY || "",

  // Search provider: 'serp' (default) | 'exa'
  productSearchProvider: (process.env.PRODUCT_SEARCH_PROVIDER || "serp").toLowerCase().trim(),

  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 15),
  logLevel: process.env.LOG_LEVEL || "info",

  // Scraper settings
  tenderListingUrl: process.env.TENDER_LISTING_URL || "",
  keywords: process.env.KEYWORDS || "համակարգիչ",

  // Telegram chat ID that receives automatic scrape notifications.
  // Can be a personal chat, group, or channel (use numeric ID or @handle).
  notifyChatId: process.env.NOTIFY_CHAT_ID || "",
};

function assertReadyForBot() {
  const missing = [];
  if (!config.telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");

  if (config.productSearchProvider === "exa") {
    if (!config.exaApiKey) missing.push("EXA_API_KEY");
  } else {
    // Default: serp
    if (!config.serpApiKey) missing.push("SERPAPI_API_KEY");
  }

  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(
        ", ",
      )}. Copy .env.example to .env and fill them in.`,
    );
  }
}

module.exports = { config, assertReadyForBot };

