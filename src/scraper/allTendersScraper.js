'use strict';

/**
 * Scrapes ALL tenders from the listing pages (no keyword filter).
 * Returns an array of { name, date, link } objects.
 *
 * This is used by the daily scheduler and manual scrape button to
 * detect newly published tenders across the entire listing — keyword
 * matching happens downstream, after the comparison step.
 */

/**
 * Extracts all tenders visible on a single listing page.
 * Each result has: { name, date, link }
 */
async function findAllTendersOnPage(page) {
  return page.$$eval(
    '.cont_bar.large-9.columns .tender',
    (tenders) => {
      const results = [];
      for (const tender of tenders) {
        const link = tender.querySelector('p.cont_text a');
        if (!link) continue;

        const name = (link.textContent || '').trim();
        const href = link.href;

        // Publication date — look for a <span> or <p> with a date-like pattern
        // Common selectors observed on e-procurement.am listings
        let date = null;
        const dateEl =
          tender.querySelector('.date') ||
          tender.querySelector('.cont_date') ||
          tender.querySelector('span[class*="date"]') ||
          tender.querySelector('p.date');

        if (dateEl) {
          date = (dateEl.textContent || '').trim();
        }

        // Fallback: scan all text nodes for a date pattern DD.MM.YYYY
        if (!date) {
          const tenderText = tender.textContent || '';
          const match = tenderText.match(/\b(\d{2}\.\d{2}\.\d{4})\b/);
          if (match) date = match[1];
        }

        // Try to find a direct download link (ZIP) on the listing card
        let downloadLink = null;
        const dlEl = tender.querySelector('a[href$=".zip"], a[download]');
        if (dlEl) {
          downloadLink = dlEl.href;
        }

        results.push({ name, date, link: href, downloadLink });
      }
      return results;
    }
  );
}

/**
 * Reads the pagination block and returns the "next page" URL, or null.
 */
async function getNextPageUrl(page) {
  const href = await page
    .locator('.pagination.bootom__line a.e')
    .first()
    .getAttribute('href')
    .catch(() => null);
  return href || null;
}

/**
 * Walks all listing pages starting at startUrl, following pagination,
 * and collects every tender { name, date, link, downloadLink }.
 *
 * @param {import('playwright').Page} page
 * @param {string} startUrl
 * @returns {Promise<Array<{name: string, date: string|null, link: string, downloadLink: string|null}>>}
 */
async function collectAllTenders(page, startUrl) {
  const all = [];
  const visited = new Set();

  let currentUrl = startUrl;
  let pageNumber = 1;

  while (currentUrl && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    console.log(`[allTendersScraper] Page ${pageNumber}: ${currentUrl}`);

    await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });

    const tenders = await findAllTendersOnPage(page);
    console.log(`[allTendersScraper] Page ${pageNumber}: found ${tenders.length} tender(s)`);

    all.push(...tenders);

    currentUrl = await getNextPageUrl(page);
    pageNumber += 1;
  }

  console.log(`[allTendersScraper] Total tenders collected: ${all.length}`);
  return all;
}

module.exports = { collectAllTenders, findAllTendersOnPage, getNextPageUrl };
