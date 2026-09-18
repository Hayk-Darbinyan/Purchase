const { GoogleAiModeSource } = require('./googleAiModeSource');
const { ExaSource } = require('./exaSource');
const { rankCandidates } = require('../verify/matchVerifier');
const { config } = require('../config');
const logger = require('../logger');

// ── Lazy singletons ─────────────────────────────────────────────────────────
let googleAiMode = null;
let exaSource = null;

function getGoogleAiModeSource() {
  if (!googleAiMode) {
    googleAiMode = new GoogleAiModeSource();
  }
  return googleAiMode;
}

function getExaSource() {
  if (!exaSource) {
    exaSource = new ExaSource();
  }
  return exaSource;
}

// ── Provider selection ──────────────────────────────────────────────────────
/**
 * Returns the active MarketSource based on PRODUCT_SEARCH_PROVIDER.
 * Defaults to GoogleAiModeSource ('serp') to maintain backward compatibility.
 */
function getActiveSource() {
  if (config.productSearchProvider === 'exa') {
    return getExaSource();
  }
  return getGoogleAiModeSource();
}

function rankExaListings(listings) {
  return listings
    .map((listing) => {
      const matching = Array.isArray(listing.matching) ? listing.matching : [];
      const matches = matching.filter((item) => item.status === 'match').length;
      const mismatches = matching.filter((item) => item.status === 'mismatch').length;
      const confidence = matching.length ? matches / matching.length : 0;
      return { listing, confidence, matched: matches, mismatched: mismatches, unchecked: matching.length - matches - mismatches };
    })
    .sort((left, right) => right.confidence - left.confidence);
}

// ── Public API ──────────────────────────────────────────────────────────────
/**
 * Finds market matches for a single normalized product.
 * The `query` argument is the full search prompt built by pipeline.js.
 * The return shape is the same regardless of the active provider.
 *
 * @param {Object} normalizedProduct
 * @param {string|string[]} query
 * @returns {Promise<{ stage: string, ranked: Object[], aiResponse: string }>}
 */
async function findMarketMatch(normalizedProduct, query) {
  const searchQuery = Array.isArray(query) ? query[0] : query;
  const source = getActiveSource();

  const provider = config.productSearchProvider === 'exa' ? 'exa' : 'google_ai_mode';
  logger.info(`Using search provider: ${provider}`);

  const listings = await source.search(searchQuery, { normalizedProduct });
  const ranked = config.productSearchProvider === 'exa'
    ? rankExaListings(listings)
    : rankCandidates(normalizedProduct, listings);

  return {
    stage: ranked.length ? provider : 'none',
    ranked,
    aiResponse: listings._aiResponse || listings._fullText || '',
  };
}

module.exports = { findMarketMatch, getGoogleAiModeSource, getExaSource };