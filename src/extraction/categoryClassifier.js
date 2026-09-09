const { CATEGORIES, UNKNOWN_CATEGORY } = require("./categories");

/**
 * Classifies a product into one of the registered categories by counting
 * keyword hits across its name + raw spec text. Purely lexical — no ML
 * model, no external calls, so it's instant and has zero failure modes
 * beyond "no keywords matched" (-> unknown).
 */
function classifyCategory(product) {
  const haystack = `${product.name} ${product.techSpecRaw}`.toLowerCase();

  let best = null;
  let bestScore = 0;

  for (const category of CATEGORIES) {
    let score = 0;
    for (const kw of category.classifierKeywords) {
      if (haystack.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }

  return best && bestScore > 0 ? best : UNKNOWN_CATEGORY;
}

module.exports = { classifyCategory };
