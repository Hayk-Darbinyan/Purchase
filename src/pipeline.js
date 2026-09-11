const { parseDocx } = require("./parsers/docxParser");
const { findMarketMatch } = require("./search");
const logger = require("./logger");

/**
 * Builds the Google AI Mode prompt directly from product name and technical specification.
 */
function buildGoogleAiPrompt(product) {
  const name = (product.name || "").trim();
  const techSpec = (
    product.techSpecRaw ||
    (product.techSpecLines || []).join("\n")
  ).trim();

  return (
    `Carefully search for all products in Armenian stores that match the following technical specification.\n` +
    `Find the actual product pages, not just store/category/search pages.\n` +
    `Return ALL relevant matching products found across Armenian stores.\n\n` +
    `Product Name: ${name}\n` +
    `Technical Specification:\n${techSpec}\n\n` +
    `Output ONLY this format, with no explanations or extra text:\n` +
    `Product name + main specifications\n` +
    `Product page URL`
  );
}

/**
 * Runs one product directly through Google AI Mode (SerpApi):
 * DOCX (name + techSpec) -> Google AI Mode prompt -> SerpApi & Match.
 */
async function processProduct(product) {
  const prompt = buildGoogleAiPrompt(product);

  logger.info("Processing product with Google AI Mode (SerpApi)", {
    row: product.rowNumber,
    name: product.name,
    promptLength: prompt.length,
  });

  const normalized = {
    ...product,
    category: product.name || "product",
    attributes: (product.techSpecLines || []).map((line) => ({
      key: null,
      label: "",
      value: line,
      raw: line,
    })),
    rawLines: product.techSpecLines || [],
  };

  const result = await findMarketMatch(normalized, prompt);
  return {
    product,
    normalized,
    category: { categoryId: normalized.category },
    prompt,
    result,
  };
}

/**
 * Parses a tender DOCX buffer and processes every product it contains.
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

module.exports = { runPipeline, processProduct, buildGoogleAiPrompt };