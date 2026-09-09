/**
 * Usage: node scripts/testLocal.js path/to/tender.docx
 *
 * Runs the parser -> extraction (AI-based, with rule-based fallback) ->
 * query-building stages against a local file and prints the results.
 *
 * - If GEMINI_API_KEY is set in .env, extraction uses Gemini and you'll
 *   see `method: ai` in the output.
 * - If it isn't set, extraction automatically falls back to the old
 *   rule-based extractor (`method: heuristic`) — nothing crashes, you
 *   just get lower-quality extraction, exactly like in production.
 * - If TAVILY_API_KEY is also set, this additionally runs the live
 *   market search; otherwise it stops after printing the search query,
 *   so you can sanity-check extraction without spending API credits.
 */
const fs = require("fs");
const path = require("path");
const { config } = require("../src/config");
const { parseDocx } = require("../src/parsers/docxParser");
const { extractProductSpec } = require("../src/extraction");

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/testLocal.js <file.docx>");
    process.exit(1);
  }

  console.log(
    config.geminiApiKey
      ? "AI extraction: ENABLED (Gemini)"
      : "AI extraction: DISABLED (no GEMINI_API_KEY set — using rule-based fallback)"
  );

  const buffer = fs.readFileSync(path.resolve(filePath));
  const { products, warnings } = await parseDocx(buffer);

  console.log(`\nParsed ${products.length} product row(s).`);
  warnings.forEach((w) => console.log(`  ⚠️  ${w}`));

  for (const product of products) {
    const { normalized, query, method } = await extractProductSpec(product);

    console.log("\n" + "=".repeat(70));
    console.log(`Row ${product.rowNumber}: ${product.name}`);
    console.log(`Extraction method: ${method}`);
    console.log(`Product type / category: ${normalized.category}`);
    console.log(`Quantity: ${product.quantity}  Unit price: ${product.unitPrice}`);
    console.log("\nExtracted characteristics:");
    for (const a of normalized.attributes) {
      console.log(`  - ${a.label || "(unlabeled)"}: ${a.value}`);
    }
    console.log(`\nSearch query:\n  "${query}"`);

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
