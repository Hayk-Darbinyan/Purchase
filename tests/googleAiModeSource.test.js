const test = require('node:test');
const assert = require('node:assert');
const { GoogleAiModeSource } = require('../src/search/googleAiModeSource');

test('GoogleAiModeSource correctly parses structured product name and URL pairs', () => {
  const source = new GoogleAiModeSource();

  const text = `
1. Lenovo ThinkPad E14 Gen 5 (Intel Core i5-1335U, 16GB RAM, 512GB SSD)
https://redstore.am/product/lenovo-thinkpad-e14

2. ASUS ExpertBook B1 (Intel Core i5, 16GB, 512GB)
https://vega.am/laptops/asus-expertbook-b1
  `;

  const listings = source.parseStructuredOutput(text);

  assert.strictEqual(listings.length, 2);
  assert.strictEqual(
    listings[0].title,
    'Lenovo ThinkPad E14 Gen 5 (Intel Core i5-1335U, 16GB RAM, 512GB SSD)'
  );
  assert.strictEqual(listings[0].url, 'https://redstore.am/product/lenovo-thinkpad-e14');
  assert.strictEqual(listings[0].store, 'redstore.am');

  assert.strictEqual(
    listings[1].title,
    'ASUS ExpertBook B1 (Intel Core i5, 16GB, 512GB)'
  );
  assert.strictEqual(listings[1].url, 'https://vega.am/laptops/asus-expertbook-b1');
  assert.strictEqual(listings[1].store, 'vega.am');
});

test('GoogleAiModeSource transformResponse merges parsed text and references', () => {
  const source = new GoogleAiModeSource();

  const mockSerpApiResponse = {
    text_blocks: [
      {
        text: 'Lenovo ThinkPad E14 (16GB RAM, 512GB SSD)\nhttps://redstore.am/product/lenovo-thinkpad-e14',
      },
    ],
    references: [
      {
        title: 'Lenovo ThinkPad E14 at YerevanMobile',
        link: 'https://yerevanmobile.am/laptops/thinkpad-e14',
        snippet: 'Price: 350,000 AMD in stock',
      },
    ],
  };

  const listings = source.transformResponse(mockSerpApiResponse, 'Laptop Lenovo');

  assert.strictEqual(listings.length, 2);
  assert.strictEqual(listings[0].url, 'https://redstore.am/product/lenovo-thinkpad-e14');
  assert.strictEqual(listings[1].url, 'https://yerevanmobile.am/laptops/thinkpad-e14');
  assert.strictEqual(listings[1].store, 'yerevanmobile.am');
  assert.ok(listings._aiResponse);
  assert.strictEqual(listings._rawResponse, mockSerpApiResponse);
});

test('GoogleAiModeSource returns fallback synthesis listing if no URLs found', () => {
  const source = new GoogleAiModeSource();

  const mockSerpApiResponse = {
    text_blocks: [
      {
        text: 'Unfortunately, no exact matching product could be located in Armenian stores.',
      },
    ],
    references: [],
  };

  const listings = source.transformResponse(mockSerpApiResponse, 'Unobtainable device');

  assert.strictEqual(listings.length, 1);
  assert.strictEqual(listings[0].pageType, 'ai_overview');
  assert.ok(listings[0].content.includes('no exact matching product'));
  assert.ok(listings._aiResponse);
});

