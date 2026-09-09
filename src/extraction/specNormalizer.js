const commonAliases = require("./categories/common");

// Armenian tender sheets use the "՝" mark (as well as plain ":") as a
// label/value separator, e.g. "Չափ՝ 13 դյույմ". A backtick sometimes
// appears in place of "՝" too — a common artifact of the Armenian
// keyboard layout / autocorrect substituting the modifier letter.
const SEPARATOR_REGEX = /[՝:`]/;

// A line counts as a bare "section header" (e.g. "Պրոցեսոր (CPU)",
// "Կապի հնարավորություններ") rather than a value line when it has no
// digits and no separator. Real spec *values* in these documents always
// carry a number, a unit, or a version string (Wi-Fi 7, Bluetooth 5.4...).
function looksLikeHeader(line) {
  return !SEPARATOR_REGEX.test(line) && !/\d/.test(line);
}

function splitLabelValue(line) {
  const idx = line.search(SEPARATOR_REGEX);
  return {
    label: line.slice(0, idx).trim(),
    value: line.slice(idx + 1).trim(),
  };
}

/**
 * Resolves a raw label string to a canonical field name using this
 * category's alias dictionary, falling back to the common/universal
 * dictionary, and finally to the raw label itself (slugified) so nothing
 * is ever dropped.
 */
/**
 * Finds the best canonical key for a label by picking the LONGEST
 * matching alias pattern across the category's own dictionary first,
 * then the common dictionary — longest match wins so a more specific
 * alias (e.g. "aspect ratio") isn't shadowed by a shorter, broader one
 * that happens to be a substring of the label (e.g. "display").
 */
function resolveCanonicalKey(label, fieldAliases) {
  const norm = label.toLowerCase();

  function bestMatch(dict) {
    let best = null;
    let bestLen = 0;
    for (const [canonical, patterns] of Object.entries(dict)) {
      for (const p of patterns) {
        if (norm.includes(p) && p.length > bestLen) {
          best = canonical;
          bestLen = p.length;
        }
      }
    }
    return best;
  }

  return bestMatch(fieldAliases) || bestMatch(commonAliases) || null;
}

/**
 * Parses raw spec lines into a flat list of attributes:
 *   { key, label, value, raw }
 * `key` is the canonical field name when recognized, otherwise null.
 * `label` is always the original Armenian/English label text so the
 * output stays human-readable and auditable even when unrecognized.
 *
 * The full original lines are always returned too (`rawLines`), so
 * downstream steps (query building, verification) can fall back to raw
 * text matching if the structured parse misses something — this parser
 * is best-effort, not a guarantee, given how varied tender documents are.
 */
function normalizeSpecLines(lines, fieldAliases) {
  const attributes = [];
  let pendingSection = null; // { label, key }

  function flushPendingSection(fallbackValue) {
    if (pendingSection) {
      attributes.push({
        key: pendingSection.key,
        label: pendingSection.label,
        value: fallbackValue || null,
        raw: pendingSection.label,
      });
      pendingSection = null;
    }
  }

  for (const line of lines) {
    if (SEPARATOR_REGEX.test(line)) {
      // "Label: value" pair — closes out any pending section first.
      flushPendingSection(null);
      const { label, value } = splitLabelValue(line);
      attributes.push({
        key: resolveCanonicalKey(label, fieldAliases),
        label,
        value,
        raw: line,
      });
    } else if (looksLikeHeader(line)) {
      // A new section header — close the previous one (it had no
      // explicit value line, e.g. integrated GPU noted only in its own
      // header text), then start tracking this one.
      flushPendingSection(null);
      pendingSection = {
        label: line,
        key: resolveCanonicalKey(line, fieldAliases),
      };
    } else {
      // A bare value line with no separator (e.g. "Wi-Fi 7") — attach it
      // to the current pending section if there is one, else record it
      // standalone.
      if (pendingSection) {
        attributes.push({
          key: pendingSection.key,
          label: pendingSection.label,
          value: line,
          raw: line,
        });
        // Section stays open: some sections (e.g. connectivity) span
        // several consecutive bare value lines.
      } else {
        attributes.push({ key: null, label: null, value: line, raw: line });
      }
    }
  }
  flushPendingSection(null);

  return attributes;
}

function normalizeProductSpec(product, category) {
  const attributes = normalizeSpecLines(
    product.techSpecLines,
    category.fieldAliases || {}
  );
  return {
    ...product,
    category: category.categoryId,
    attributes,
    rawLines: product.techSpecLines,
  };
}

module.exports = { normalizeProductSpec, normalizeSpecLines };
