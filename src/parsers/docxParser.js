const mammoth = require("mammoth");
const cheerio = require("cheerio");
const logger = require("../logger");

/**
 * Maps header-cell text (Armenian tender vocabulary) to a canonical field
 * name. Matching is substring-based on lowercased text, so minor wording
 * variations across tender templates still resolve correctly.
 *
 * Extend this list (not the parsing logic below) to support new templates.
 */
const HEADER_ALIASES = [
  { field: "rowNumber", patterns: ["№", "n"] },
  { field: "name", patterns: ["անվանում"] },
  { field: "techSpec", patterns: ["տեխնիկական բնութագ", "բնութագիր"] },
  { field: "unit", patterns: ["չ/մ", "չափման միավոր"] },
  { field: "unitPrice", patterns: ["միավոր գին"] },
  { field: "totalPrice", patterns: ["ընդհանուր գին", "ընդամեն"] },
  { field: "quantity", patterns: ["քանակ"] },
  { field: "deliveryTerm", patterns: ["մատակարարման ժամկետ", "ժամկետ"] },
];

function resolveField(headerText) {
  const norm = headerText.trim().toLowerCase();
  for (const alias of HEADER_ALIASES) {
    if (alias.patterns.some((p) => norm.includes(p))) return alias.field;
  }
  return null;
}

/**
 * A row counts as a genuine header row only if it resolves at least
 * `name` and `techSpec` — those two are the columns we actually depend on.
 */
function isHeaderRow(fieldMap) {
  const resolved = new Set(Object.values(fieldMap).filter(Boolean));
  return resolved.has("name") && resolved.has("techSpec");
}

/**
 * Extracts spec-line paragraphs from a table cell's HTML, one string per
 * <p> (mammoth emits one <p> per original Word paragraph, which is exactly
 * how these tender templates lay out one spec attribute per line).
 */
function extractCellLines($, cellEl) {
  const $cell = $(cellEl);
  const paras = $cell.find("p");
  let lines;
  if (paras.length) {
    lines = paras.map((_, p) => $(p).text().replace(/\s+/g, " ").trim()).get();
  } else {
    // Fallback: no <p> tags found (e.g. a bare text node) — split on
    // whatever line breaks mammoth preserved.
    lines = $cell
      .text()
      .split("\n")
      .map((l) => l.trim());
  }
  return lines.filter(Boolean);
}

function cellText($, cellEl) {
  return $(cellEl).text().replace(/\s+/g, " ").trim();
}

function rowCells($, rowEl) {
  return $(rowEl).children("td,th").toArray();
}

function rowCellsByColumn($, rowEl) {
  const cellsByColumn = [];
  let column = 0;

  for (const cellEl of rowCells($, rowEl)) {
    while (cellsByColumn[column]) column += 1;
    const span = Math.max(1, Number.parseInt($(cellEl).attr("colspan"), 10) || 1);
    cellsByColumn[column] = cellEl;
    for (let offset = 1; offset < span; offset += 1) {
      cellsByColumn[column + offset] = null;
    }
    column += span;
  }

  return cellsByColumn;
}

/**
 * Parses a tender-style DOCX buffer into a list of product rows.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{products: object[], warnings: string[]}>}
 */
async function parseDocx(buffer) {
  const warnings = [];
  const result = await mammoth.convertToHtml({ buffer });
  if (result.messages && result.messages.length) {
    for (const m of result.messages) {
      logger.debug("mammoth message", { message: m.message });
    }
  }

  const $ = cheerio.load(result.value);
  const tables = $("table").toArray();
  if (!tables.length) {
    warnings.push("No tables found in the document.");
    return { products: [], warnings };
  }

  const products = [];

  for (const table of tables) {
    const rows = $(table).children("tbody,thead,tfoot").children("tr").toArray();
    const tableRows = rows.length ? rows : $(table).children("tr").toArray();

    // 1. Find the header row: the first row whose cells resolve to a
    //    field map containing both `name` and `techSpec`.
    let headerRowIndex = -1;
    let fieldByColumn = [];
    for (let ri = 0; ri < tableRows.length; ri++) {
      const cells = rowCellsByColumn($, tableRows[ri]);
      const map = cells.map((c) => (c ? resolveField(cellText($, c)) : null));
      if (isHeaderRow(Object.fromEntries(map.map((f, i) => [i, f])))) {
        headerRowIndex = ri;
        fieldByColumn = map;
        break;
      }
    }

    if (headerRowIndex === -1) {
      warnings.push(
        "Could not find a recognizable header row (name + technical " +
          "specification columns) in one of the tables — skipping it."
      );
      continue;
    }

    // 2. Walk data rows below the header.
    for (let ri = headerRowIndex + 1; ri < tableRows.length; ri++) {
      const cells = rowCellsByColumn($, tableRows[ri]);
      if (!cells.length) continue;

      const rowFieldMap = cells.map((c) => (c ? resolveField(cellText($, c)) : null));
      if (isHeaderRow(Object.fromEntries(rowFieldMap.map((f, i) => [i, f])))) {
        fieldByColumn = rowFieldMap;
        continue;
      }

      const product = {
        rowNumber: null,
        name: "",
        techSpecRaw: "",
        techSpecLines: [],
        unit: "",
        unitPrice: "",
        totalPrice: "",
        quantity: "",
        deliveryTerm: "",
      };

      cells.forEach((cellEl, ci) => {
        if (!cellEl) return;
        const field = fieldByColumn[ci];
        if (!field) return;
        if (field === "techSpec") {
          const lines = extractCellLines($, cellEl);
          product.techSpecLines = lines;
          product.techSpecRaw = lines.join("\n");
        } else {
          product[field] = cellText($, cellEl);
        }
      });

      // Skip placeholder/empty rows (e.g. a row that only has a row
      // number like "2" with every other cell blank — common in tender
      // templates that ship with unused rows).
      if (!product.name && !product.techSpecRaw) continue;
      if (!product.techSpecRaw) {
        warnings.push(
          `Row ${product.rowNumber || ri} ("${product.name}") has no ` +
            "technical specification text — skipping it."
        );
        continue;
      }

      products.push(product);
    }
  }

  return { products, warnings };
}

module.exports = { parseDocx };
