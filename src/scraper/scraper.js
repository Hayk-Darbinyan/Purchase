'use strict';

const KEYWORD = 'համակարգիչ';

async function findMatchingTendersOnPage(page) {
  return page.$$eval(
    '.cont_bar.large-9.columns .tender',
    (tenders, keyword) => {
      const results = [];
      for (const tender of tenders) {
        const link = tender.querySelector('p.cont_text a');
        if (!link) continue;
        const title = (link.textContent || '').trim();
        results.push({ title, href: link.href, matched: title.includes(keyword) });
      }
      return results;
    },
    KEYWORD
  );
}

/**
 * Reads the pagination block and returns the "next page" URL, or null
 * if there isn't one (i.e. we're on the last page).
 *
 * <div class="pagination bootom__line" ...>
 *   ... <a href="..." class="e">❯</a>
 * </div>
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
 * Walks the listing starting at startUrl, following pagination, and
 * collects every matching tender {title, href} across all pages.
 */
async function collectMatchingTenders(page, startUrl) {
  const matches = [];
  const visited = new Set();

  let currentUrl = startUrl;
  let pageNumber = 1;
  while (currentUrl && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    console.log(`\n[Page ${pageNumber}] ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });

    const allTenders = await findMatchingTendersOnPage(page);
    console.log(`[Page ${pageNumber}] ${allTenders.length} tender(s) found.`);

    allTenders.forEach((tender, i) => {
      const tag = tender.matched ? 'MATCH' : 'skip';
      console.log(`[Page ${pageNumber}] Tender ${i + 1}/${allTenders.length} [${tag}]: ${tender.title}`);
    });

    const pageMatches = allTenders.filter((t) => t.matched);
    matches.push(...pageMatches);

    currentUrl = await getNextPageUrl(page);
    pageNumber += 1;
  }

  return matches;
}

module.exports = {
  KEYWORD,
  findMatchingTendersOnPage,
  getNextPageUrl,
  collectMatchingTenders,
};