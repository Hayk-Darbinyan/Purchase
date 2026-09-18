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

        // Publication date and submission deadline — extracted from p.tender_time.
        // Example source text:
        //   "Հրапаракված է 2026-09-17 07:06:16-ից մinchev 2026-10-05 14:00:00 жamy nerarбali"
        let date = null;
        let startDate = null;
        let endDate = null;

        const dateEl = tender.querySelector('p.tender_time');
        if (dateEl) {
          const text = (dateEl.textContent || '').trim();

          // Try to extract the full "from … to …" range
          // Example: "Հրապարակված է 2026-09-17 07:06:16-ից մինչեւ 2026-10-05 14:00:00 ժամը ներառյալ"
          const fullRangeMatch =
            text.match(/Հրապարակված\s+է\s+([\d-]+(?:\s+[\d:]+)?)-ից\s+մինչ[ևեւ]\s+([\d-]+(?:\s+[\d:]+)?)/i) ||
            text.match(/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)[^\d]+(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)/);

          if (fullRangeMatch) {
            startDate = fullRangeMatch[1].trim();
            endDate = fullRangeMatch[2].trim();
            date = startDate; // preserve existing behaviour: date == publication date
          } else {
            // Fallback: extract just the first date as before
            const match =
              text.match(/Հրապարակված է\s+([\d-]+\s+[\d:]+)/i) ||
              text.match(/Հրապարակված է\s+([\d-]+)/i) ||
              text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/) ||
              text.match(/(\d{4}-\d{2}-\d{2})/);
            date = match ? match[1].trim() : text;
            startDate = date;
          }
        }

        results.push({ name, date, startDate, endDate, link: href });
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
 * and collects every tender { name, date, link }.
 *
 * @param {import('playwright').Page} page
 * @param {string} startUrl
 * @returns {Promise<Array<{name: string, date: string|null, link: string}>>}
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
