const { parseDocx } = require("./parsers/docxParser");
const { extractProductSpec } = require("./extraction");
const { findMarketMatch } = require("./search");
const logger = require("./logger");

/**
 * Runs one product all the way through: extract (AI, with rule-based
 * fallback) -> search -> rank. Never throws for a "no match" outcome —
 * only for genuine failures (e.g. the search API being unreachable), so
 * one bad product doesn't take down the whole batch.
 */
async function processProduct(product) {
  const { normalized, query, method } = await extractProductSpec(product);

  logger.info("Processing product", {
    row: product.rowNumber,
    name: product.name,
    category: normalized.category,
    extractionMethod: method,
    query,
  });

  const result = await findMarketMatch(normalized, query);
  return { product, normalized, category: { categoryId: normalized.category }, query, extractionMethod: method, result };
}

/**
 * Parses a tender DOCX buffer and processes every product it contains.
 * Products are processed sequentially (not Promise.all) to keep Tavily
 * request volume predictable and logs readable in order.
 */
async function runPipeline(docxBuffer) {
  const { products, warnings } = await parseDocx(docxBuffer);

  if (!products.length) {
    return { products: [], warnings, results: [] };
  }

  const results = [];
  for (const product of products) {
    try {
      results.push(await processProduct(product));
    } catch (err) {
      logger.error("Failed to process product", {
        name: product.name,
        error: err.message,
      });
      results.push({
        product,
        error: err.message,
      });
    }
  }

  return { products, warnings, results };
}

module.exports = { runPipeline, processProduct };
