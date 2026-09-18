'use strict';

function requirementLines(product) {
  if (Array.isArray(product.techSpecLines) && product.techSpecLines.length) return product.techSpecLines;
  if (Array.isArray(product.rawLines) && product.rawLines.length) return product.rawLines;
  return (product.attributes || []).map((attribute) => attribute.raw || attribute.value).filter(Boolean);
}

function normalizeTenderRequirements(product = {}) {
  return requirementLines(product).map((line) => {
    const requirement = String(line).trim();
    const separator = requirement.search(/[:：\-–—]/);
    const parameter = separator > 0 ? requirement.slice(0, separator).trim() : requirement;
    return { parameter, requirement };
  });
}

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeExaProduct(product, tenderProduct = {}, urlOverride = '') {
  if (!product || typeof product !== 'object') return null;
  const requirements = normalizeTenderRequirements(tenderProduct);
  let supplied = product.specifications;
  if (typeof supplied === 'string') {
    try { supplied = JSON.parse(supplied); } catch { supplied = []; }
  }
  supplied = Array.isArray(supplied) ? supplied : [];
  const byParameter = new Map(supplied.map((item) => [cleanText(item.parameter).toLowerCase(), item]));
  const matching = requirements.map((requirement) => {
    const result = byParameter.get(requirement.parameter.toLowerCase()) || byParameter.get(requirement.requirement.toLowerCase());
    const status = result && ['match', 'mismatch', 'not_found'].includes(result.status) ? result.status : 'not_found';
    return {
      parameter: requirement.parameter,
      status,
      value: status === 'not_found' ? '' : cleanText(result.value),
      requiredValue: requirement.requirement,
    };
  });

  const url = cleanText(urlOverride || product.directProductUrl);
  if (!url) return null;
  return {
    name: cleanText(product.productName),
    price: cleanText(product.currentPrice),
    currency: cleanText(product.currency),
    url,
    store: cleanText(product.store),
    matching,
  };
}

module.exports = { normalizeTenderRequirements, normalizeExaProduct };
