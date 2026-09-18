'use strict';

const Exa = require('exa-js').default || require('exa-js');
const { MarketSource } = require('./MarketSource');
const { config } = require('../config');
const logger = require('../logger');
const { normalizeTenderRequirements, normalizeExaProduct } = require('../normalize/exaNormalizer');

const DEFAULT_ARMENIAN_DOMAINS = [
  'zigzag.am', 'vega.am', 'vesta.am', 'led.am', 'vlv.am', 'aray.am',
  'beko.am', 'electronicsplanet.am', 'fine.am', 'mtech.am', 'arsiel.am',
  'icenter.am', 'hardware.am', 'notebookcentre.am', 'hiphone.am',
  'pc-electronics.am', 'vdcomputers.com', 'megamall.am', 'electro.am',
  'heraxos.am', 'itplaza.am', 'mobax.am', 'device.am', 'gagat.am',
  'nout.am', 'plusstore.am', 'eldorado.am', 'onshop.am', 'vivaelectronics.am',
  'smartbox.am', 'ph-electronics.am', 'jetman.am', 'gt-electronics.am',
  'bork.am', 'rezon.am', 'complife.am', 'allsell.am', '3dplanet.am',
  'yerevanmobile.am', 'notebookmall.am', 'dgcomp.am',
];

const CATEGORY_OR_SEARCH_PATTERNS = [
  /\/(?:catalog|category|categories|search|tag|brand)(?:\/|\?|$)/i,
  /[?&](?:q|query|s|search)=/i,
];

function isProductPageUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname !== '/' && !CATEGORY_OR_SEARCH_PATTERNS.some((pattern) => pattern.test(url));
  } catch {
    return false;
  }
}

function cleanStore(url, store) {
  if (store && typeof store === 'string') return store.trim();
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isAllowedStoreUrl(url, domains) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return domains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^www\./, '');
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          productName: { type: 'string' },
          currentPrice: { type: 'string' },
          currency: { type: 'string' },
          directProductUrl: { type: 'string' },
          store: { type: 'string' },
          specifications: { type: 'string' },
        },
        required: ['productName', 'directProductUrl'],
      },
    },
  },
  required: ['products'],
};

function buildSystemPrompt(requirements) {
  return [
    'Find actual currently sellable products from Armenian online stores only, including products that only partially satisfy the tender.',
    'Use direct product pages, never category, search, home, or foreign pages.',
    'Return up to five relevant products even when some requirements mismatch or are unavailable.',
    'Use the current selling price only; ignore installment, monthly, crossed-out, and old prices.',
    'The tender requirements below are the only source of truth. Return exactly one specification result for every requirement for every returned product.',
    'Put specifications in the specifications field as a JSON array string. Each array item must contain parameter, status, and value.',
    'A match explicitly satisfies the requirement. A mismatch explicitly contradicts it. Use not_found when the product page does not provide enough information. Never infer or invent values.',
    'Evaluate numbers, minimums, maximums, ranges, quantities, capacities, dimensions, compatibility, and other requirement types according to their meaning.',
    `Tender requirements (preserve each parameter exactly):\n${requirements.map((item) => `- ${item.parameter}: ${item.requirement}`).join('\n')}`,
  ].join('\n');
}

function buildProductSearchQuery(product, requirements) {
  const name = String(product.name || '').trim();
  const requirementTerms = requirements
    .map((item) => item.requirement)
    .join(' ')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1100);
  return [name, requirementTerms, 'Armenian online store product price specifications'].filter(Boolean).join(' ').slice(0, 1500);
}

class ExaSource extends MarketSource {
  constructor(apiKey = config.exaApiKey) {
    super();
    this.apiKey = apiKey;
  }

  async search(query, options = {}) {
    const apiKey = this.apiKey || config.exaApiKey || process.env.EXA_API_KEY;
    if (!apiKey) {
      logger.error('EXA_API_KEY is missing. Please set it in .env');
      return [];
    }

    const domains = (process.env.ARMENIAN_STORE_DOMAINS || DEFAULT_ARMENIAN_DOMAINS.join(','))
      .split(',').map((domain) => domain.trim()).filter(Boolean);
    const requirements = normalizeTenderRequirements(options.normalizedProduct || {});
    // The pipeline query is written for SERP's AI mode and says "match".
    // Exa needs a discovery query instead, otherwise partial candidates are discarded.
    const safeQuery = buildProductSearchQuery(options.normalizedProduct || {}, requirements)
      || String(query || '').slice(0, 1500);

    try {
      const exa = new Exa(apiKey);
      const response = await exa.search(safeQuery, {
        type: 'auto',
        numResults: 10,
        includeDomains: domains,
        contents: { text: { maxCharacters: 4000 } },
        systemPrompt: buildSystemPrompt(requirements),
        outputSchema: OUTPUT_SCHEMA,
      });
      return this.transformResponse(response, options.normalizedProduct, domains);
    } catch (error) {
      logger.error('Exa structured product search failed', { error: error.message || String(error) });
      return [];
    }
  }

  transformResponse(response, normalizedProduct = {}, domains = DEFAULT_ARMENIAN_DOMAINS) {
    const content = response && response.output && response.output.content;
    const parsed = typeof content === 'string' ? this.parseContent(content) : content;
    const products = parsed && Array.isArray(parsed.products) ? parsed.products : [];
    const discovered = response && Array.isArray(response.results) ? response.results : [];
    const sourceProducts = products.length ? products : discovered.map((item) => ({
      productName: item.title || '',
      directProductUrl: item.url || '',
      store: '',
      currentPrice: '',
      currency: '',
      specifications: '[]',
    }));
    const seen = new Set();
    const listings = [];

    for (const product of sourceProducts) {
      const url = product && product.directProductUrl;
      if (!isProductPageUrl(url) || !isAllowedStoreUrl(url, domains)) continue;
      const key = url.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      const structured = normalizeExaProduct(product, normalizedProduct, url);
      if (!structured) continue;
      listings.push({
        title: structured.name,
        url: structured.url,
        store: structured.store || cleanStore(url),
        price: structured.price,
        currency: structured.currency,
        matching: structured.matching,
        pageType: 'product',
        content: '',
      });
    }

    const limited = listings.slice(0, 5);
    limited._rawResponse = response;
    limited._aiResponse = '';
    limited._fullText = '';
    limited.grounding = response && response.output ? response.output.grounding || [] : [];
    return limited;
  }

  parseContent(content) {
    try { return typeof content === 'string' ? JSON.parse(content) : content; } catch { return null; }
  }
}

module.exports = { ExaSource, OUTPUT_SCHEMA, isProductPageUrl };
