const { confidenceLabel } = require("../verify/matchVerifier");

const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeMdV2(text) {
  if (text == null) return "";
  return String(text).replace(MDV2_SPECIAL, "\\$&");
}

// Inside a MarkdownV2 inline-link URL, only "\" and ")" need escaping —
// escaping the same way as body text would corrupt the URL itself.
function escapeMdV2Url(url) {
  if (!url) return "";
  return String(url).replace(/([\\)])/g, "\\$1");
}

function formatUrl(url) {
  if (!url) return "Not available";
  return `[${escapeMdV2("Open listing")}](${escapeMdV2Url(url)})`;
}

/**
 * Tries to pull a brand/model guess out of the ranked listing's title,
 * since these tender sheets themselves rarely state a brand/model. This
 * is a best-effort display convenience, not a verified fact — the
 * listing title is quoted as found, nothing is invented.
 */
function guessBrandModelFromTitle(title) {
  if (!title) return { brand: null, model: null };
  const parts = title.split(/[\s,–-]+/).filter(Boolean);
  return { brand: parts[0] || null, model: parts.slice(1, 4).join(" ") || null };
}

function formatProductResult(product, result) {
  const header = `*${escapeMdV2(`Product ${product.rowNumber || ""}: ${product.name}`)}*`;

  if (!result || !result.ranked || !result.ranked.length) {
    return (
      `${header}\n` +
      `❌ ${escapeMdV2(
        "No matching product page was found across Armenian stores for this specification."
      )}\n` +
      `_${escapeMdV2("You may need to search manually or relax the spec constraints.")}_`
    );
  }

  // When multiple matches are found (e.g. via Google AI Mode)
  if (result.ranked.length > 1) {
    let text = `${header}\n`;
    text += `_${escapeMdV2(`Found ${result.ranked.length} matching products across Armenian stores:`)}_\n\n`;

    result.ranked.forEach((r, idx) => {
      const listing = r.listing;
      const { brand, model } = guessBrandModelFromTitle(listing.title);
      const label = confidenceLabel(r.confidence);
      const pct = Math.round(r.confidence * 100);

      text += `*${idx + 1}\\. ${escapeMdV2(listing.title)}*\n`;
      if (listing.store && listing.store !== "google.com") {
        text += `🏪 *Store:* ${escapeMdV2(listing.store)}\n`;
      }
      text += `🔗 *URL:* ${formatUrl(listing.url)}\n`;
      if (listing.content && listing.content !== listing.title) {
        text += `📝 *Specs:* ${escapeMdV2(listing.content.slice(0, 180))}\n`;
      }
      text += `🎯 *Match:* ${escapeMdV2(`${label} (${pct}%)`)}\n\n`;
    });

    return text.trim();
  }

  const top = result.ranked[0];
  const { brand, model } = guessBrandModelFromTitle(top.listing.title);
  const label = confidenceLabel(top.confidence);
  const pct = Math.round(top.confidence * 100);

  let scopeNote = "";
  if (result.stage === "global") {
    scopeNote = `_${escapeMdV2("No Armenian listing met the confidence threshold — showing best global match.")}_\n`;
  } else if (result.stage === "google_ai_mode") {
    scopeNote = `_${escapeMdV2("Sourced via Google AI Mode.")}_\n`;
  }

  const mismatchNote = top.mismatched && top.mismatched.length
    ? `⚠️ ${escapeMdV2(
        `Possible mismatch on: ${top.mismatched.join(", ")}`
      )}\n`
    : "";

  return (
    `${header}\n` +
    `${scopeNote}` +
    `*Product name:* ${escapeMdV2(top.listing.title)}\n` +
    `*Brand:* ${escapeMdV2(brand || "Not stated in listing")}\n` +
    `*Model:* ${escapeMdV2(model || "Not stated in listing")}\n` +
    `*Description:* ${escapeMdV2(top.listing.content.slice(0, 300))}\n` +
    `*Price:* ${escapeMdV2(top.listing.price || "Not listed — check the product page")}\n` +
    `*Store:* ${escapeMdV2(top.listing.store || "Unknown")}\n` +
    `*URL:* ${formatUrl(top.listing.url)}\n` +
    `*Match confidence:* ${escapeMdV2(`${label} (${pct}%)`)}\n` +
    `${mismatchNote}`
  ).trim();
}

module.exports = { formatProductResult, escapeMdV2 };
