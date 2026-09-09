/**
 * Usage: node scripts/testLocal.js path/to/tender.docx
 *
 * Runs the parser -> classifier -> normalizer -> query-builder stages
 * against a local file and prints the results. If TAVILY_API_KEY is set
 * in .env, it also runs the live market search; otherwise it stops after
 * printing the built search query, so you can sanity-check the
 * extraction pipeline without spending API credits.
 */
const fs = require("fs");
const path = require("path");
const { config } = require("../src/config");
const { parseDocx } = require("../src/parsers/docxParser");
const { classifyCategory } = require("../src/extraction/categoryClassifier");
const { normalizeProductSpec } = require("../src/extraction/specNormalizer");
const { buildSearchQuery } = require("../src/identify/queryBuilder");

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/testLocal.js <file.docx>");
    process.exit(1);
  }

  const buffer = fs.readFileSync(path.resolve(filePath));
  const { products, warnings } = await parseDocx(buffer);

  console.log(`\nParsed ${products.length} product row(s).`);
  warnings.forEach((w) => console.log(`  ⚠️  ${w}`));

  for (const product of products) {
    const category = classifyCategory(product);
    const normalized = normalizeProductSpec(product, category);
    const query = buildSearchQuery(normalized);

    console.log("\n" + "=".repeat(70));
    console.log(`Row ${product.rowNumber}: ${product.name}`);
    console.log(`Category: ${category.categoryId}`);
    console.log(`Quantity: ${product.quantity}  Unit price: ${product.unitPrice}`);
    console.log("\nNormalized attributes:");
    for (const a of normalized.attributes) {
      console.log(`  - [${a.key || "unmapped"}] ${a.label || ""}: ${a.value}`);
    }
    console.log(`\nBuilt search query:\n  "${query}"`);

    if (config.tavilyApiKey) {
      const { findMarketMatch } = require("../src/search");
      const { confidenceLabel } = require("../src/verify/matchVerifier");
      console.log("\nRunning live market search...");
      const result = await findMarketMatch(normalized, query);
      console.log(`Search stage: ${result.stage}`);
      result.ranked.slice(0, 3).forEach((r, i) => {
        console.log(
          `  ${i + 1}. [${confidenceLabel(r.confidence)} ${(r.confidence * 100).toFixed(
            0
          )}%] ${r.listing.title} — ${r.listing.url}`
        );
      });
    } else {
      console.log(
        "\n(Set TAVILY_API_KEY in .env to also run a live market search here.)"
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
