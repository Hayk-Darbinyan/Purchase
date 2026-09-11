const { GoogleAiModeSource } = require("./googleAiModeSource");
const { rankCandidates } = require("../verify/matchVerifier");

let googleAiMode = null;

function getGoogleAiModeSource() {
  if (!googleAiMode) {
    googleAiMode = new GoogleAiModeSource();
  }
  return googleAiMode;
}

async function findMarketMatch(normalizedProduct, query) {
  const searchQuery = Array.isArray(query) ? query[0] : query;
  const source = getGoogleAiModeSource();
  const listings = await source.search(searchQuery, { normalizedProduct });
  const ranked = rankCandidates(normalizedProduct, listings);
  return {
    stage: ranked.length ? "google_ai_mode" : "none",
    ranked,
    aiResponse: listings._aiResponse || listings._fullText || "",
  };
}

module.exports = { findMarketMatch, getGoogleAiModeSource };