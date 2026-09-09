// Preferred attribute order per category — the most identifying specs
// first, since Tavily/search engines weight early query terms more.
const PRIORITY_KEYS = {
  laptop_tablet: ["deviceType", "screenSize", "cpu", "ram", "storage", "os"],
  smartphone: ["ram", "storage", "mainCamera", "battery", "screenSize"],
  tv_monitor: ["screenSize", "resolution", "panelType", "refreshRate"],
  major_appliance: ["capacity", "energyClass", "coolingSystem"],
  headphones_audio: ["connectionType", "noiseCancel", "driverSize"],
  printer: ["printType", "functions", "printSpeed"],
  camera: ["sensor", "lens", "videoResolution"],
};

function attrText(attr) {
  if (!attr.value) return null;
  return attr.value.replace(/^[՝:\s]+/, "").trim();
}

/**
 * Builds a plain-language search query out of a normalized product's
 * most identifying attributes. Tender sheets rarely name an exact brand
 * or model — they specify a capability envelope — so the query describes
 * the product, it doesn't assert a specific model exists.
 */
function buildSearchQuery(normalizedProduct) {
  const { category, attributes, name } = normalizedProduct;
  const byKey = {};
  for (const a of attributes) {
    const text = attrText(a);
    if (a.key && text && !byKey[a.key]) byKey[a.key] = text;
  }

  const order = PRIORITY_KEYS[category] || [];
  const parts = [];

  // Lead with the product's own name/type label from the sheet.
  if (name) parts.push(name);

  for (const key of order) {
    if (byKey[key]) parts.push(byKey[key]);
  }

  // Fill in anything else recognized but not already prioritized,
  // capped so the query doesn't balloon into an unusable wall of text.
  for (const [key, value] of Object.entries(byKey)) {
    if (!order.includes(key) && value && parts.length < 8) {
      parts.push(value);
    }
  }

  if (parts.length <= 1) {
    // Structured parse found almost nothing usable — fall back to the
    // first couple of raw lines rather than searching on just the name.
    parts.push(...normalizedProduct.rawLines.slice(0, 3));
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

module.exports = { buildSearchQuery };
