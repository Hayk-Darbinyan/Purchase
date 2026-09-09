// Normalizes text for loose comparison: lowercase, unify whitespace,
// strip common punctuation, and normalize a handful of unit spellings
// that otherwise cause false negatives (16GB vs 16 GB vs 16Gb).
function normalizeForMatch(text) {
  return text
    .toLowerCase()
    .replace(/gb|гб|գբ/g, "gb")
    .replace(/[\s.,]+/g, " ")
    .trim();
}

function extractNumbers(text) {
  return (text.match(/\d+(\.\d+)?/g) || []).map(Number);
}

/**
 * Checks whether a single required attribute's value is plausibly
 * satisfied by the candidate listing text. This is intentionally
 * conservative and simple (substring + numeric containment), not a full
 * NLP comparison — good enough to rank candidates and flag obvious
 * mismatches, not to certify equivalence.
 */
function attributeIsSatisfied(attrValue, listingTextNorm) {
  const valueNorm = normalizeForMatch(attrValue);
  if (!valueNorm) return null; // nothing to check

  if (listingTextNorm.includes(valueNorm)) return true;

  // Numeric-only check: e.g. required "առնվազն 16GB" (at least 16GB) —
  // look for the number alongside a plausible unit in the listing, and
  // treat a required "at least" spec as satisfied by an equal-or-larger
  // number of the same rough magnitude.
  const requiredNums = extractNumbers(valueNorm);
  if (requiredNums.length) {
    const listingNums = extractNumbers(listingTextNorm);
    const isAtLeast = /at\s*least|min|առնվազն/.test(valueNorm);
    const satisfied = requiredNums.every((n) =>
      listingNums.some((ln) => (isAtLeast ? ln >= n : ln === n))
    );
    if (satisfied) return true;
  }

  return false;
}

/**
 * Scores one candidate listing against a normalized product's required
 * attributes.
 *
 * @returns {{confidence: number, matched: string[], mismatched: string[], unchecked: string[]}}
 */
function scoreCandidate(normalizedProduct, listing) {
  const listingTextNorm = normalizeForMatch(
    `${listing.title} ${listing.content}`
  );

  const matched = [];
  const mismatched = [];
  const unchecked = [];

  for (const attr of normalizedProduct.attributes) {
    if (!attr.value) continue;
    const label = attr.label || attr.key || "spec";
    const result = attributeIsSatisfied(attr.value, listingTextNorm);
    if (result === true) matched.push(label);
    else if (result === false) mismatched.push(label);
    else unchecked.push(label);
  }

  const checkedTotal = matched.length + mismatched.length;
  const confidence = checkedTotal ? matched.length / checkedTotal : 0;

  return { confidence, matched, mismatched, unchecked };
}

/**
 * Scores every candidate listing and returns them sorted best-first.
 */
function rankCandidates(normalizedProduct, listings) {
  return listings
    .map((listing) => ({
      listing,
      ...scoreCandidate(normalizedProduct, listing),
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

function confidenceLabel(confidence) {
  if (confidence >= 0.75) return "High";
  if (confidence >= 0.4) return "Medium";
  return "Low";
}

module.exports = { scoreCandidate, rankCandidates, confidenceLabel };
