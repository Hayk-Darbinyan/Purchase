const { config } = require("../config");

/**
 * Central place to register Armenian retailer domains. Sourced from
 * ARMENIAN_STORE_DOMAINS in .env by default so no code change is needed
 * to add a store — but if a store needs a dedicated scraper later (the
 * way the MonitoringBot project has store-specific matchers), register
 * it here with a `directScraper` hook and the search orchestrator will
 * prefer it over the generic Tavily pass automatically.
 */
const ARMENIAN_STORES = config.armenianStoreDomains.map((domain) => ({
  domain,
  directScraper: null, // e.g. require('./scrapers/redstore') later
}));

function listDomains() {
  return ARMENIAN_STORES.map((s) => s.domain);
}

function withDirectScraper() {
  return ARMENIAN_STORES.filter((s) => s.directScraper);
}

module.exports = { ARMENIAN_STORES, listDomains, withDirectScraper };
