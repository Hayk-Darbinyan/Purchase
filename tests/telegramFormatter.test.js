const test = require('node:test');
const assert = require('node:assert');
const { formatProductResult, escapeMdV2 } = require('../src/format/telegramFormatter');

test('telegramFormatter correctly escapes reserved MarkdownV2 characters in global results', () => {
  const product = { rowNumber: 1, name: 'Sample Item v1.2.3 (Spec sheet #4)' };
  const result = {
    stage: 'global',
    ranked: [
      {
        listing: {
          title: 'Asus ZenBook 14.5" OLED (2026)',
          url: 'https://example.com/item/1.html?ref=xyz_123',
          content: 'High-end specs with 32GB RAM, 1TB SSD. Tested at 99.9% reliability!',
          price: '$1,299.99',
          store: 'amazon.com',
        },
        confidence: 0.85,
        mismatched: ['RAM.size'],
      },
    ],
  };

  const formatted = formatProductResult(product, result);

  // Verify that raw periods outside of markdown URLs are escaped.
  // In MarkdownV2 URLs (inside parentheses), periods are not escaped per Telegram API.
  const textWithoutUrls = formatted.replace(/\]\([^)]+\)/g, ']');
  const unescapedDots = textWithoutUrls.match(/(?<!\\)\./g);
  assert.strictEqual(
    unescapedDots,
    null,
    `Found unescaped dots in MarkdownV2 output: ${JSON.stringify(unescapedDots)}`
  );

  assert.ok(formatted.includes('best global match'));
});

test('telegramFormatter correctly escapes empty ranked results', () => {
  const product = { rowNumber: 2, name: 'Special Item.doc' };
  const result = { stage: 'none', ranked: [] };

  const formatted = formatProductResult(product, result);
  const unescapedDots = formatted.match(/(?<!\\)\./g);
  assert.strictEqual(unescapedDots, null);
});
