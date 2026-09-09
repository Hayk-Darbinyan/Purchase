const { classifyCategory } = require("./categoryClassifier");
const { normalizeProductSpec } = require("./specNormalizer");
const { buildSearchQuery } = require("../identify/queryBuilder");
const { extractSpecWithAI, isAiExtractionAvailable } = require("./aiSpecExtractor");
const logger = require("../logger");

/**
 * Converts the AI extractor's open-ended output into the same shape the
 * search/verification layer already consumes (see specNormalizer.js) —
 * so search/index.js and matchVerifier.js need zero changes.
 */
function toNormalizedShape(product, aiResult) {
  const attributes = aiResult.characteristics.map((c) => ({
    key: null, // AI extraction doesn't map to fixed canonical fields on purpose
    label: c.label,
    value: c.value,
    raw: `${c.label}: ${c.value}`,
  }));

  return {
    ...product,
    category: aiResult.productType || "ai_extracted",
    attributes,
    rawLines: product.techSpecLines,
  };
}

/**
 * Extracts structured, search-ready information from one product's raw
 * spec text. Tries Gemini-based extraction first (understands arbitrary
 * product categories and mixed Armenian/Russian/English text); falls
 * back to the deterministic rule-based extractor if no API key is
 * configured, or if the AI call fails for any reason — the bot keeps
 * working either way, just with reduced extraction quality on fallback.
 *
 * Returns { normalized, query, method } where method is "ai" or
 * "heuristic", purely for logging/transparency.
 */
async function extractProductSpec(product) {
  if (isAiExtractionAvailable()) {
    const aiResult = await extractSpecWithAI(product);
    if (aiResult) {
      return {
        normalized: toNormalizedShape(product, aiResult),
        query: aiResult.searchQuery,
        method: "ai",
      };
    }
    logger.warn("Falling back to rule-based extraction for this product", {
      name: product.name,
    });
  }

  const category = classifyCategory(product);
  const normalized = normalizeProductSpec(product, category);
  const query = buildSearchQuery(normalized);
  return { normalized: { ...normalized, category: category.categoryId }, query, method: "heuristic" };
}

module.exports = { extractProductSpec };
