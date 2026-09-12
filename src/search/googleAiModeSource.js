const { getJson } = require('serpapi');
const { MarketSource } = require('./MarketSource');
const { config } = require('../config');
const logger = require('../logger');

class GoogleAiModeSource extends MarketSource {
  constructor(apiKey = config.serpApiKey) {
    super();
    this.apiKey = apiKey;
  }

  /**
   * Performs a Google AI Mode search via SerpApi and returns MarketListings
   * @param {string} query
   * @param {Object} [options]
   * @returns {Promise<import('./MarketSource').MarketListing[]>}
   */
  async search(query, options = {}) {
    logger.info('GoogleAiModeSource (SerpApi) initiating search', {
      queryLength: query.length,
    });

    const apiKey = this.apiKey || config.serpApiKey || process.env.SERPAPI_API_KEY;
    if (!apiKey) {
      logger.error('SERPAPI_API_KEY is missing. Please set it in .env');
      return [];
    }

    // Google / SerpApi GET request URLs have length limits.
    // Truncate overly long queries (~1500 chars) to prevent HTTP 400 URI Too Long.
    const safeQuery = query.length > 1500 ? query.slice(0, 1500) : query;

    try {
      const data = await getJson({
        engine: 'google_ai_mode',
        q: safeQuery,
        api_key: apiKey,
        hl: options.hl || 'hy',
        gl: options.gl || 'am',
      });

      if (!data) return [];
      if (data.error) {
        logger.warn('SerpApi returned error', { error: data.error });
        return [];
      }

      return this.transformResponse(data, safeQuery);
    } catch (err) {
      const errMsg = (err && (err.message || (typeof err === 'string' ? err : JSON.stringify(err)))) || 'Unknown SerpApi error';
      logger.error('SerpApi Google AI Mode search failed', { error: errMsg });
      return [];
    }
  }

  /**
   * Transforms SerpApi response into MarketListings
   */
  transformResponse(data, originalQuery) {
    // 1. Extract full text from text_blocks
    let fullText = '';
    if (Array.isArray(data.text_blocks)) {
      fullText = data.text_blocks
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b.text) return b.text;
          if (b.snippet) return b.snippet;
          if (Array.isArray(b.items)) return b.items.join('\n');
          return '';
        })
        .filter(Boolean)
        .join('\n\n');
    } else if (data.ai_overview) {
      fullText =
        typeof data.ai_overview === 'string'
          ? data.ai_overview
          : JSON.stringify(data.ai_overview);
    }

    // 2. Parse structured product name + specs + URL pairs from fullText
    const parsedListings = this.parseStructuredOutput(fullText);

    // 3. Extract sources from references if present
    const references = Array.isArray(data.references) ? data.references : [];
    const referenceListings = references
      .map((ref) => {
        const link = ref.link || ref.url;
        if (!link) return null;
        let domain = '';
        try {
          domain = new URL(link).hostname.replace(/^www\./, '');
        } catch {}
        return {
          title: ref.title || domain || 'Product Link',
          url: link,
          content: ref.snippet || ref.title || '',
          store: domain || 'Armenian Store',
          pageType: 'product',
        };
      })
      .filter(Boolean);

    // Deduplicate by URL
    const seen = new Set();
    const listings = [];

    for (const item of [...parsedListings, ...referenceListings]) {
      if (!item.url) continue;
      const normUrl = item.url.toLowerCase().trim();
      if (seen.has(normUrl)) continue;
      seen.add(normUrl);
      listings.push(item);
    }

    // Fallback if no specific URLs were extracted but full text exists
    if (!listings.length && fullText) {
      listings.push({
        title: 'Google AI Mode Response',
        url: 'https://serpapi.com/search?engine=google_ai_mode',
        content: fullText,
        store: 'Google AI Mode',
        pageType: 'ai_overview',
      });
    }

    listings._rawResponse = data;
    listings._fullText = fullText;
    listings._aiResponse = fullText;
    return listings;
  }

  /**
   * Parses the requested format:
   * Line 1: Product name + main specifications
   * Line 2: Product page URL
   */
  parseStructuredOutput(text) {
    if (!text || typeof text !== 'string') return [];
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const listings = [];
    const urlRegex = /(https?:\/\/[^\s)\]]+)/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(urlRegex);

      if (match) {
        let rawUrl = match[1].replace(/[.,;:)]+$/, '');
        let domain = '';
        try {
          domain = new URL(rawUrl).hostname.replace(/^www\./, '');
        } catch {}

        let title = '';
        if (i > 0 && !lines[i - 1].match(urlRegex)) {
          title = lines[i - 1];
        } else {
          title = line
            .replace(match[0], '')
            .replace(/^[-—–:\s]+|[-—–:\s]+$/g, '')
            .trim();
        }

        title =
          title
            .replace(/^[\d+.)\-*•\s]+/, '')
            .replace(/[*_~`]/g, '')
            .trim() ||
          domain ||
          'Armenian Store Product';

        if (rawUrl && !rawUrl.includes('serpapi.com') && !rawUrl.includes('google.com/search')) {
          listings.push({
            title,
            url: rawUrl,
            content: title,
            store: domain || 'Armenian Store',
            pageType: 'product',
          });
        }
      }
    }

    return listings;
  }
}

module.exports = { GoogleAiModeSource };
