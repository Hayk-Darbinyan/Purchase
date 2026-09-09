const { tavily } = require("@tavily/core");
const { MarketSource } = require("./MarketSource");
const { config } = require("../config");
const logger = require("../logger");

class TavilySource extends MarketSource {
  constructor() {
    super();
    this.client = tavily({ apiKey: config.tavilyApiKey });
  }

  /**
   * @param {string} query
   * @param {{ domains?: string[], armenianOnly?: boolean, maxResults?: number }} options
   */
  async search(query, options = {}) {
    const params = {
      searchDepth: "advanced",
      maxResults: options.maxResults || 8,
    };
    if (options.domains && options.domains.length) {
      params.includeDomains = options.domains;
      params.includeDomainsMode = "filter";
    } else if (options.armenianOnly) {
      // Broaden beyond the fixed store list, but still bias toward the
      // Armenian market when we're not restricting to specific domains.
      params.country = "armenia";
    }

    let response;
    try {
      response = await this.client.search(query, params);
    } catch (err) {
      logger.error("Tavily search failed", { query, error: err.message });
      return [];
    }

    return (response.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      store: this._domainToStoreName(r.url),
    }));
  }

  _domainToStoreName(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return host;
    } catch {
      return null;
    }
  }
}

module.exports = { TavilySource };
