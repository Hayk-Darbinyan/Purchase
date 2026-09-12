'use strict';

const path = require('path');
const fs = require('fs');

async function downloadInviteZip(page, tenderUrl, downloadDir) {
  await page.goto(tenderUrl, { waitUntil: 'domcontentloaded' });

  const downloadLink = page
    .locator('.fe_g', { has: page.locator('.fe_t', { hasText: 'Հրավեր' }) })
    .locator('.fe_v a[download]')
    .first();

  if ((await downloadLink.count()) === 0) {
    return null;
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadLink.click(),
  ]);

  const suggested = download.suggestedFilename() || 'tender.zip';
  fs.mkdirSync(downloadDir, { recursive: true });
  const zipPath = path.join(downloadDir, suggested);
  await download.saveAs(zipPath);

  return zipPath;
}

module.exports = { downloadInviteZip };