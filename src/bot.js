const { Telegraf } = require("telegraf");
const axios = require("axios");
const { config, assertReadyForBot } = require("./config");
const logger = require("./logger");
const { runPipeline } = require("./pipeline");
const { formatProductResult } = require("./format/telegramFormatter");
// const http = require("http");

assertReadyForBot();

const bot = new Telegraf(config.telegramBotToken);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

bot.start((ctx) =>
  ctx.reply(
    "Send me a tender/procurement spec sheet as a .docx file and I'll " +
      "look up matching real products on the Armenian market (and " +
      "globally if nothing reliable turns up locally).\n\n" +
      "Currently supported format: DOCX. XLSX and PDF support are planned."
  )
);

bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  const isDocx =
    doc.mime_type === DOCX_MIME || (doc.file_name || "").endsWith(".docx");

  if (!isDocx) {
    await ctx.reply(
      "I can only read .docx files for now — please upload the spec " +
        "sheet in Word format. XLSX/PDF support is planned."
    );
    return;
  }

  const sizeMb = doc.file_size / (1024 * 1024);
  if (sizeMb > config.maxFileSizeMb) {
    await ctx.reply(
      `That file is ${sizeMb.toFixed(1)}MB, which is over the ${
        config.maxFileSizeMb
      }MB limit.`
    );
    return;
  }

  const statusMsg = await ctx.reply("📄 Reading the document...");

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(fileLink.href, {
      responseType: "arraybuffer",
    });

    const { products, warnings, results } = await runPipeline(
      Buffer.from(data)
    );

    for (const w of warnings) {
      await ctx.reply(`⚠️ ${w}`);
    }

    if (!products.length) {
      await ctx.reply(
        "I couldn't find any product rows with technical specifications " +
          "in this document. Please check the file structure."
      );
      return;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `📄 Found ${products.length} product(s). Searching the market for each...`
    );

    for (const r of results) {
      if (r.error) {
        await ctx.reply(
          `❌ Product "${r.product.name}": something went wrong while ` +
            `searching (${r.error}). Skipped.`
        );
        continue;
      }
      const text = formatProductResult(r.product, r.result);
      try {
        await ctx.replyWithMarkdownV2(text, { disable_web_page_preview: false });
      } catch (sendErr) {
        logger.warn("replyWithMarkdownV2 failed, falling back to plain text", {
          error: sendErr.message,
        });
        // Strip MarkdownV2 backslash escapes and formatting tokens for clean plain text fallback
        const plainText = text
          .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1")
          .replace(/[*_~`]/g, "");
        await ctx.reply(plainText);
      }
    }
  } catch (err) {
    logger.error("Failed to process uploaded document", { error: err.message });
    await ctx.reply(
      "Something went wrong while processing that file. Please try again " +
        "or check that it's a valid .docx tender document."
    );
  }
});

bot.on("message", async (ctx) => {
  if (ctx.message.document) return; // handled above
  await ctx.reply("Please upload a tender spec sheet as a .docx file.");
});

bot.catch((err, ctx) => {
  logger.error("Unhandled bot error", { error: err.message });
  ctx.reply("An unexpected error occurred. Please try again.").catch(() => {});
});

bot.launch().then(() => logger.info("Bot started"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// const PORT = process.env.PORT || 3000;

// const healthServer = http.createServer((req, res) => {
//   res.writeHead(200, { "Content-Type": "text/plain" });
//   res.end("OK");
// });

// healthServer.listen(PORT, "0.0.0.0", () => {
//   logger.info(`HTTP health server listening on port ${PORT}`);
// });