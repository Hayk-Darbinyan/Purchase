/**
 * Usage: node scripts/testLocal.js path/to/tender.docx
 *
 * Runs the parser -> Google AI Mode prompt generation -> SerpApi search
 * against a local tender file and prints the results.
 */
const fs = require("fs");
const path = require("path");
const { parseDocx } = require("../src/parsers/docxParser");
const { buildGoogleAiPrompt, processProduct } = require("../src/pipeline");

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/testLocal.js <file.docx>");
    process.exit(1);
  }

  console.log(`Flow: DOCX (name + techSpec) -> Google AI Mode (SerpApi) directly\n`);

  const buffer = fs.readFileSync(path.resolve(filePath));
  const { products, warnings } = await parseDocx(buffer);

  console.log(`Parsed ${products.length} product row(s).`);
  warnings.forEach((w) => console.log(`  ⚠️  ${w}`));

  for (const product of products) {
    const prompt = buildGoogleAiPrompt(product);

    console.log("\n" + "=".repeat(70));
    console.log(`Row ${product.rowNumber}: ${product.name}`);
    console.log(`Quantity: ${product.quantity}  Unit price: ${product.unitPrice}`);
    console.log("\n--- Generated Google AI Mode Prompt ---");
    console.log(prompt);
    console.log("---------------------------------------");

    const { result } = await processProduct(product);
    console.log(`\nSearch stage: ${result.stage} (${result.ranked.length} candidate(s))`);
    result.ranked.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.listing.title}`);
      console.log(`     URL:   ${r.listing.url}`);
      console.log(`     Store: ${r.listing.store}`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});