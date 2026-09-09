const { parseDocx } = require("./parsers/docxParser");
const { classifyCategory } = require("./extraction/categoryClassifier");
const { normalizeProductSpec } = require("./extraction/specNormalizer");
const { buildSearchQuery } = require("./identify/queryBuilder");
const { findMarketMatch } = require("./search");
const logger = require("./logger");

/**
 * Runs one product all the way through: classify -> normalize -> build
 * query -> search -> rank. Never throws for a "no match" outcome — only
 * for genuine failures (e.g. the search API being unreachable), so one
 * bad product doesn't take down the whole batch.
 */
async function processProduct(product) {
  const category = classifyCategory(product);
  const normalized = normalizeProductSpec(product, category);
  const query = buildSearchQuery(normalized);

  logger.info("Processing product", {
    row: product.rowNumber,
    name: product.name,
    category: category.categoryId,
    query,
  });

  const result = await findMarketMatch(normalized, query);
  return { product, normalized, category, query, result };
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
