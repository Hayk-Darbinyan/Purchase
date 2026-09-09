const { TavilySource } = require("./tavilySource");
const { listDomains, withDirectScraper } = require("./armenianStores");
const { rankCandidates } = require("../verify/matchVerifier");
const { config } = require("../config");
const logger = require("../logger");

const tavily = new TavilySource();

/**
 * Runs the full "Armenian market first, global fallback" search strategy
 * for one normalized product, and returns the ranked candidate list from
 * whichever stage produced a usable result — plus which stage that was,
 * so callers/output can be transparent about it.
 */
async function findMarketMatch(normalizedProduct, query) {
  // Stage 0: any store registered with a direct scraper (none by default
  // — this is the hook for adding store-specific scrapers later, the way
  // the MonitoringBot project does per-retailer).
  for (const store of withDirectScraper()) {
    try {
      const listings = await store.directScraper(query);
      const ranked = rankCandidates(normalizedProduct, listings);
      if (ranked.length && ranked[0].confidence >= config.armenianMatchMinConfidence) {
        return { stage: "armenian_direct_scraper", ranked };
      }
    } catch (err) {
      logger.warn("Direct scraper failed", { store: store.domain, error: err.message });
    }
  }

  // Stage 1: Tavily restricted to known Armenian retailer domains.
  const amDomainListings = await tavily.search(query, {
    domains: listDomains(),
  });
  let ranked = rankCandidates(normalizedProduct, amDomainListings);
  if (ranked.length && ranked[0].confidence >= config.armenianMatchMinConfidence) {
    return { stage: "armenian_domains", ranked };
  }

  // Stage 2: Tavily broad Armenian-market search (not domain-restricted,
  // in case a relevant store isn't in our registry yet).
  const amBroadListings = await tavily.search(`${query} Armenia Երևան`, {
    armenianOnly: true,
  });
  ranked = rankCandidates(normalizedProduct, amBroadListings);
  if (ranked.length && ranked[0].confidence >= config.armenianMatchMinConfidence) {
    return { stage: "armenian_broad", ranked };
  }

  // Stage 3: global fallback, no geographic restriction.
  const globalListings = await tavily.search(query, { maxResults: 10 });
  ranked = rankCandidates(normalizedProduct, globalListings);
  if (ranked.length) {
    return { stage: "global", ranked };
  }

  return { stage: "none", ranked: [] };
}

module.exports = { findMarketMatch };
