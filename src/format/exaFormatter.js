'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatExaResult(product, result) {
  const lines = [`<b>Product ${escapeHtml(product.rowNumber || '')}: ${escapeHtml(product.name)}</b>`];
  const ranked = result && Array.isArray(result.ranked) ? result.ranked : [];
  if (!ranked.length) return `${lines[0]}\n❌ No matching product was found.`;

  ranked.forEach((candidate, index) => {
    const item = candidate.listing;
    lines.push('', `<b>${index + 1}. ${escapeHtml(item.title)}</b>`);
    lines.push(`Store: ${escapeHtml(item.store || 'Not found')}`);
    lines.push(`Price: ${escapeHtml([item.price, item.currency].filter(Boolean).join(' ') || 'Not found')}`);
    lines.push(`URL: ${escapeHtml(item.url)}`);
    lines.push('<b>Specification matching:</b>');
    for (const requirement of item.matching || []) {
      if (requirement.status === 'match') {
        lines.push(`✅ ${escapeHtml(requirement.parameter)}: ${escapeHtml(requirement.value)}`);
      } else if (requirement.status === 'mismatch') {
        lines.push(`❌ ${escapeHtml(requirement.parameter)}: actual ${escapeHtml(requirement.value)}; required ${escapeHtml(requirement.requiredValue)}`);
      } else {
        lines.push(`❓ ${escapeHtml(requirement.parameter)}: Տեղեկություն չի գտնվել`);
      }
    }
  });
  return lines.join('\n');
}

module.exports = { formatExaResult };
