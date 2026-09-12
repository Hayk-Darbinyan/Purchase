'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const { collectMatchingTenders, KEYWORD } = require('./scraper');
const { downloadInviteZip } = require('./download');
const { extractAndReadDocuments } = require('./extract');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');

// Browser/context settings. Kept in one place so they're easy to tweak.
const BROWSER_LAUNCH_OPTIONS = {
  headless: false, // set true to run without a visible window
  slowMo: 0, // e.g. 100 to slow down actions for debugging
};

const CONTEXT_OPTIONS = {
  acceptDownloads: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
  locale: 'hy-AM',
};

async function run(startUrl) {
  if (!startUrl) {
    console.error('Usage: node src/index.js <listing-url>');
    process.exit(1);
  }

  console.log('Launching browser with options:', BROWSER_LAUNCH_OPTIONS);
  const browser = await chromium.launch(BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const listingPage = await context.newPage();

  console.log(`Scanning listing pages for tenders containing "${KEYWORD}"...`);
  const matches = await collectMatchingTenders(listingPage, startUrl);
  console.log(`\nFound ${matches.length} matching tender(s) in total.`);

  const results = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    console.log(`\n=== Matched tender ${i + 1}/${matches.length} ===`);
    console.log(`Title: ${match.title}`);
    console.log(`URL:   ${match.href}`);

    const detailPage = await context.newPage();

    try {
      console.log('Opening detail page and looking for the "Հրավեր" download button...');
      const zipPath = await downloadInviteZip(detailPage, match.href, DOWNLOAD_DIR);

      if (!zipPath) {
        console.warn('No download button found on this tender page, skipping.');
        results.push({ ...match, zipPath: null, error: 'download_button_not_found' });
        continue;
      }
      console.log(`Download complete: ${zipPath}`);

      console.log('Extracting ZIP...');
      const { extractDir, source, files } = await extractAndReadDocuments(zipPath);
      console.log(`Extracted to: ${extractDir}`);
      console.log(`Reading ${files.length} ${source || 'no'} file(s)...`);
      files.forEach((f, idx) => console.log(`  [${idx + 1}] ${f.path} (${f.text.length} chars)`));

      results.push({
        ...match,
        zipPath,
        extractDir,
        source,
        files: files.map((f) => ({ path: f.path, textLength: f.text.length })),
      });
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      results.push({ ...match, error: err.message });
    } finally {
      await detailPage.close();
    }
  }

  await browser.close();
  console.log('\nBrowser closed.');

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const resultsPath = path.join(DOWNLOAD_DIR, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nDone. Summary written to ${resultsPath}`);

  return results;
}

if (require.main === module) {
  const startUrl = process.argv[2];
  run(startUrl).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };