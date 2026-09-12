'use strict';

const mammoth = require('mammoth');
const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// generic text helpers
// ---------------------------------------------------------------------------

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function includesPhrase(haystack, phrase) {
  return normalize(haystack).toUpperCase().includes(normalize(phrase).toUpperCase());
}

/**
 * Finds the value that follows a label in a list of text lines.
 * Handles both "Label: value" on one line and "Label" / "value" on
 * two separate lines.
 */
function findLabelValue(lines, labelVariants) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const label of labelVariants) {
      const idx = line.indexOf(label);
      if (idx === -1) continue;

      let after = line.slice(idx + label.length).trim();
      after = after.replace(/^[:՝\-–—.]+\s*/, '');
      if (after) return after;

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next) return next;
      }
    }
  }
  return null;
}

const PHONE_REGEX = /(\+?\d[\d\-\s()]{6,}\d)/;
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Locates the contact-information section (by label keywords) and pulls
 * name / phone / email out of the lines that follow it.
 *
 * Armenian tender documents keep the evaluating-commission secretary's
 * contact in the announcement header (before the form sections), so we
 * also search there when the structured section is absent.
 */
function findContactPerson(lines) {
  let secretaryIdx = lines.findIndex(
    (l) => /քարտուղար/i.test(l) || /կոնտակտ/i.test(l) || /պատասխանատու\s*անձ/i.test(l)
  );

  let name = null;
  let phone = null;
  let email = null;

  if (secretaryIdx !== -1) {
    const window = lines.slice(Math.max(0, secretaryIdx - 2), secretaryIdx + 15);
    const windowText = window.join('\n');

    const emailMatch = windowText.match(EMAIL_REGEX);
    if (emailMatch) email = emailMatch[0];

    const phoneMatch = windowText.match(PHONE_REGEX);
    if (phoneMatch) phone = phoneMatch[0].trim();

    // Try to extract name following "քարտուղար" keyword
    for (const line of window) {
      const secMatch = line.match(
        /քարտուղար(?:ն\s*է)?[:՝`\s]+([Ա-Ֆա-ֆև\s]+?)(?:ին|[.,;\n]|$)/i
      );
      if (secMatch && secMatch[1]) {
        const candidate = secMatch[1].trim();
        if (candidate.length > 3 && !/էլեկտրոնային|փոստ|հասցե|հեռախոս/i.test(candidate)) {
          name = candidate;
          break;
        }
      }
    }

    if (!name) {
      name = findLabelValue(window, [
        'Անուն, ազգանուն',
        'Անուն ազգանուն',
        'Անունը, ազգանունը',
        'Անուն',
        'Ազգանուն',
      ]);
    }
  }

  // If phone / email still missing, look in the announcement header (first 60 lines)
  if (!phone || !email) {
    const topText = lines.slice(0, 60).join('\n');
    if (!email) {
      const em = topText.match(EMAIL_REGEX);
      if (em) email = em[0];
    }
    if (!phone) {
      const pm = topText.match(PHONE_REGEX);
      if (pm) phone = pm[0].trim();
    }
  }

  // Discard obvious non-name garbage
  if (
    name &&
    (/էլ[․.]?\s*փոստ/i.test(name) || /հեռախոս/i.test(name) || /կազմակերպ/i.test(name))
  ) {
    name = null;
  }

  return { name, phone, email, found: Boolean(name || phone || email) };
}

/**
 * Extracts the full content of section "7." up to (but not including)
 * the next same-level numbered section (e.g. "8."). Sub-sections such
 * as "7.1." are included since they don't match the same-level pattern.
 */
function extractSection7(lines) {
  const startIdx = lines.findIndex((l) => /^\s*7\.\s+\S/.test(l));
  if (startIdx === -1) return null;

  const collected = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*\d+\.\s+\S/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

// ---------------------------------------------------------------------------
// 2D Table Grid Builder
//
// Mammoth converts DOCX to HTML, preserving colspan/rowspan attributes.
// The old code called find('tr') on the whole table and assumed each visible
// cell maps 1-to-1 to a logical column, which breaks for any table that uses
// merged cells (rowspan / colspan) for multi-level headers or grouped columns.
//
// buildTableGrid() resolves every span into a full 2-D array so that
// grid[row][col] always returns the logical cell that "owns" that position,
// including cells whose origin is in a different row or column.
// ---------------------------------------------------------------------------

function getTableRows($, tableEl) {
  const direct = $(tableEl).children('tr').toArray();
  if (direct.length) return direct;
  return $(tableEl).children('tbody, thead, tfoot').children('tr').toArray();
}

/**
 * Builds a complete 2D matrix for a <table> element, honouring colspan and
 * rowspan. Every grid[r][c] entry has the shape:
 *   { r, col, colspan, rowspan, text, el, isOrigin }
 * where `isOrigin` is true only for the top-left physical cell of a span.
 */
function buildTableGrid($, tableEl) {
  const trList = getTableRows($, tableEl);
  if (!trList.length) return { grid: [], rowCount: 0, colCount: 0 };

  const grid = [];

  trList.forEach((tr, r) => {
    if (!grid[r]) grid[r] = [];
    let col = 0;

    $(tr)
      .children('td, th')
      .each((_, cell) => {
        // Skip cells already filled by a rowspan from a previous row
        while (grid[r][col] !== undefined) col++;

        const colspan = Math.max(1, parseInt($(cell).attr('colspan') || '1', 10));
        const rowspan = Math.max(1, parseInt($(cell).attr('rowspan') || '1', 10));
        const text = normalize($(cell).text());

        const cellObj = { r, col, colspan, rowspan, text, el: cell };

        for (let dr = 0; dr < rowspan; dr++) {
          const targetR = r + dr;
          if (!grid[targetR]) grid[targetR] = [];
          for (let dc = 0; dc < colspan; dc++) {
            grid[targetR][col + dc] = { ...cellObj, isOrigin: dr === 0 && dc === 0 };
          }
        }

        col += colspan;
      });
  });

  const rowCount = grid.length;
  const colCount = Math.max(...grid.map((row) => (row ? row.length : 0)), 0);

  // Fill any holes with empty placeholder cells
  for (let r = 0; r < rowCount; r++) {
    if (!grid[r]) grid[r] = [];
    for (let c = 0; c < colCount; c++) {
      if (!grid[r][c]) {
        grid[r][c] = { r, col: c, colspan: 1, rowspan: 1, text: '', isOrigin: true, el: null };
      }
    }
  }

  return { grid, rowCount, colCount };
}

// ---------------------------------------------------------------------------
// Multi-level Header Detection
// ---------------------------------------------------------------------------

const KNOWN_HEADER_WORDS = [
  'ՀԱՄԱՐ', 'ՉԱՓԱԲԱԺ', 'ԱՆՎԱՆՈՒՄ', 'ԲՆՈՒԹԱԳ', 'ՄԻԱՎՈՐ', 'ՔԱՆԱԿ',
  'ԳԻՆ', 'ԳԻՆԸ', 'ՀԱՍՑԵ', 'ԺԱՄԿԵՏ', 'CPV', 'ԴԱՍԱԿԱՐԳՄԱՆ', 'ԱՊՐԱՆՔԻ',
  'ՄԱՏԱԿԱՐԱՐՄԱՆ', 'ԵՆԹԱԿԱ', 'ՊԼԱՆՈՎ', 'ՄԻՋԱՆՑԻԿ', 'ԱՐԺԵՔ',
];

function isLikelyHeaderWord(text) {
  const upper = text.toUpperCase();
  return KNOWN_HEADER_WORDS.some((k) => upper.includes(k));
}

/**
 * Returns the number of rows that form the multi-level header block at the
 * top of the table. The algorithm:
 *   1. Tracks the maximum row index covered by any rowspan originating in the
 *      current header region (header region expands as new spanning cells are
 *      encountered).
 *   2. Once past the initial span region, stops at the first row that looks
 *      like a data row (starts with a lot number / numeric index and contains
 *      no header vocabulary words).
 */
function detectHeaderRowCount(grid) {
  if (!grid.length) return 0;
  let headerRows = 1;

  // Step 1: expand header region based on rowspan coverage
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r] ? grid[r].length : 0); c++) {
      const cell = grid[r][c];
      if (cell && cell.rowspan > 1 && cell.r < headerRows) {
        headerRows = Math.max(headerRows, cell.r + cell.rowspan);
      }
    }
  }

  // Step 2: search for the first data row after the span region
  for (let r = 0; r < grid.length; r++) {
    if (!grid[r] || !grid[r].length) continue;
    const firstCellText = grid[r][0].text.trim();
    const isDataStart = /^(\d+|[IVXLCDM]+|[N№]\s*\d+)/i.test(firstCellText);
    const hasLongSpecText = grid[r].some((c) => c && c.text.length > 70);
    const headerWordCount = grid[r].filter((c) => c && isLikelyHeaderWord(c.text)).length;
    const isHeavyHeader = headerWordCount >= Math.min(2, grid[r].length);

    if (r >= headerRows) {
      if ((isDataStart || hasLongSpecText) && !isHeavyHeader) {
        return r; // this row is the first data row
      }
      if (isHeavyHeader) {
        headerRows = r + 1; // absorb this row into the header block
      }
    }
  }

  return Math.min(headerRows, grid.length);
}

/**
 * For each logical column, aggregates the text from every header row into a
 * hierarchical descriptor.  For example, a table with:
 *   Row 0: ["Ապրանքի"  (colspan 8)]
 *   Row 1: ["Հրավ. Համ.", "Չ/Մ", "Ք-տ", "Մատակ." (colspan 3)]
 *   Row 2: [                              "Հ-ն",    "Ե. Ք-տ", "Ժամ."]
 * would give column 5 the descriptor text "Ապրանքի Մատակ. Հ-ն".
 */
function getColumnDescriptors(grid, headerRowCount) {
  const colCount = grid[0] ? grid[0].length : 0;
  const descriptors = [];

  for (let c = 0; c < colCount; c++) {
    const levels = [];
    for (let r = 0; r < headerRowCount; r++) {
      const cell = grid[r] && grid[r][c];
      if (!cell) continue;
      const txt = cell.text.trim();
      if (txt && !levels.includes(txt)) {
        levels.push(txt);
      }
    }
    descriptors.push({
      colIndex: c,
      levels,
      fullText: levels.join(' '),
      upper: levels.join(' ').toUpperCase(),
    });
  }

  return descriptors;
}

/**
 * Finds the first column whose combined header text matches ALL of the
 * provided keyword groups (each group is an OR list of alternatives).
 */
function findColumnByKeywords(columnDescriptors, keywordGroups) {
  for (const desc of columnDescriptors) {
    const matched = keywordGroups.every((group) =>
      group.some((kw) => desc.upper.includes(kw.toUpperCase()))
    );
    if (matched) return desc.colIndex;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Context helper — reads the headings/paragraphs immediately before a table
// ---------------------------------------------------------------------------

function getPrecedingHeading($, tableEl) {
  let node = $(tableEl);
  const texts = [];

  // If the table was wrapped in a <p> by mammoth, start from the wrapper
  if (node.parent()[0] && node.parent()[0].tagName !== 'body') {
    node = node.parent();
  }

  let prev = node.prev();
  let count = 0;
  while (prev.length && count < 6) {
    const t = normalize(prev.text());
    if (t) texts.unshift(t);
    prev = prev.prev();
    count++;
  }

  return texts.join('\n');
}

// ---------------------------------------------------------------------------
// Row-level helpers
// ---------------------------------------------------------------------------

function isSignatureOrFooterRow(rowCells) {
  const fullRowText = rowCells.map((c) => (c ? c.text : '')).join(' ').trim();
  if (!fullRowText) return true;
  if (/^[_.\-\s]+$/.test(fullRowText)) return true;
  if (/^ԳՆՈՐԴ|^ՎԱՃԱՌՈՂ|^Ընդամենը|^ԸՆԴԱՄԵՆԸ/i.test(fullRowText)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-table data extractors
// ---------------------------------------------------------------------------

function extractItemTableFromGrid(grid, headerRowCount, columnDescriptors) {
  const lotIdx = findColumnByKeywords(columnDescriptors, [['ՉԱՓԱԲԱԺ', 'ՀԱՄԱՐ', 'ԼՈՏ', 'N', '№']]);
  const unitPriceIdx = findColumnByKeywords(columnDescriptors, [['ՄԻԱՎՈՐ ԳԻՆ']]);
  let priceIdx = findColumnByKeywords(columnDescriptors, [['ԸՆԴՀԱՆՈՒՐ ԳԻՆ'], ['ԸՆԴԱՄԵՆ']]);
  if (priceIdx === -1) {
    priceIdx = findColumnByKeywords(columnDescriptors, [['ԳԻՆ']]);
  }
  // If priceIdx ended up being the same as unitPriceIdx, look for a different column for price
  if (priceIdx === unitPriceIdx) {
    priceIdx = -1;
  }
  const nameIdx = findColumnByKeywords(columnDescriptors, [['ԱՆՎԱՆՈՒՄ']]);

  const results = [];
  for (let r = headerRowCount; r < grid.length; r++) {
    const row = grid[r];
    if (!row || isSignatureOrFooterRow(row)) continue;

    const lotNumber = lotIdx !== -1 ? (row[lotIdx] && row[lotIdx].text) || null : null;
    const unitPrice = unitPriceIdx !== -1 ? (row[unitPriceIdx] && row[unitPriceIdx].text) || null : null;
    const price = priceIdx !== -1 ? (row[priceIdx] && row[priceIdx].text) || null : null;
    const itemName = nameIdx !== -1 ? (row[nameIdx] && row[nameIdx].text) || null : null;

    if (lotNumber || price || unitPrice || itemName) {
      results.push({ lotNumber, price, unitPrice, itemName });
    }
  }

  return results;
}

function extractTechSpecTableFromGrid(grid, headerRowCount, columnDescriptors) {
  const lotIdx = findColumnByKeywords(columnDescriptors, [['ՉԱՓԱԲԱԺ', 'ՀԱՄԱՐ', 'ԼՈՏ', 'N', '№']]);
  const cpvIdx = findColumnByKeywords(columnDescriptors, [['CPV', 'ԳՄԱ', 'ԾԱԾԿԱԳԻՐ']]);

  let nameIdx = findColumnByKeywords(columnDescriptors, [['ԱՄԲՈՂՋԱԿԱՆ ԱՆՎԱՆՈՒՄ']]);
  if (nameIdx === -1) nameIdx = findColumnByKeywords(columnDescriptors, [['ԱՆՎԱՆՈՒՄ']]);

  let specIdx = findColumnByKeywords(columnDescriptors, [['ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ']]);
  if (specIdx === -1) specIdx = findColumnByKeywords(columnDescriptors, [['ԲՆՈՒԹԱԳԻՐ']]);

  const results = [];
  for (let r = headerRowCount; r < grid.length; r++) {
    const row = grid[r];
    if (!row || isSignatureOrFooterRow(row)) continue;

    const lotNumber = lotIdx !== -1 ? (row[lotIdx] && row[lotIdx].text) || null : null;
    const cpvCode = cpvIdx !== -1 ? (row[cpvIdx] && row[cpvIdx].text) || null : null;
    const fullName = nameIdx !== -1 ? (row[nameIdx] && row[nameIdx].text) || null : null;
    const technicalSpecification =
      specIdx !== -1 ? (row[specIdx] && row[specIdx].text) || null : null;

    if (fullName || technicalSpecification || lotNumber) {
      results.push({
        fullName,
        technicalSpecification,
        ...(lotNumber ? { lotNumber } : {}),
        ...(cpvCode ? { cpvCode } : {}),
      });
    }
  }

  return results;
}

function extractDeliveryTableFromGrid(grid, headerRowCount, columnDescriptors) {
  const lotIdx = findColumnByKeywords(columnDescriptors, [['ՉԱՓԱԲԱԺ', 'ՀԱՄԱՐ', 'ԼՈՏ', 'N', '№']]);

  let unitIdx = findColumnByKeywords(columnDescriptors, [['ՉԱՓՄԱՆ', 'ՄԻԱՎՈՐ']]);
  if (unitIdx === -1) unitIdx = findColumnByKeywords(columnDescriptors, [['ՄԻԱՎՈՐ']]);
  if (unitIdx === -1) unitIdx = findColumnByKeywords(columnDescriptors, [['Չ/Մ']]);

  let totalQtyIdx = findColumnByKeywords(columnDescriptors, [['ԸՆԴՀԱՆՈՒՐ ՔԱՆԱԿ']]);
  if (totalQtyIdx === -1) totalQtyIdx = findColumnByKeywords(columnDescriptors, [['ԵՆԹԱԿԱ ՔԱՆԱԿ']]);
  if (totalQtyIdx === -1) totalQtyIdx = findColumnByKeywords(columnDescriptors, [['ՔԱՆԱԿ']]);

  let addressIdx = findColumnByKeywords(columnDescriptors, [['ՀԱՍՑԵ']]);
  if (addressIdx === -1) addressIdx = findColumnByKeywords(columnDescriptors, [['ՎԱՅՐ']]);

  const deadlineIdx = findColumnByKeywords(columnDescriptors, [['ԺԱՄԿԵՏ']]);

  const results = [];
  for (let r = headerRowCount; r < grid.length; r++) {
    const row = grid[r];
    if (!row || isSignatureOrFooterRow(row)) continue;

    const lotNumber = lotIdx !== -1 ? (row[lotIdx] && row[lotIdx].text) || null : null;
    const unit = unitIdx !== -1 ? (row[unitIdx] && row[unitIdx].text) || null : null;
    const totalQuantity = totalQtyIdx !== -1 ? (row[totalQtyIdx] && row[totalQtyIdx].text) || null : null;
    const address = addressIdx !== -1 ? (row[addressIdx] && row[addressIdx].text) || null : null;
    const deadline = deadlineIdx !== -1 ? (row[deadlineIdx] && row[deadlineIdx].text) || null : null;

    if (lotNumber || totalQuantity || address || deadline) {
      results.push({ lotNumber, unit, totalQuantity, address, deadline });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Table Classifier — walks the document and assigns each table to one of the
// three target roles (item, techSpec, delivery) or a "unified" catch-all.
// ---------------------------------------------------------------------------

/**
 * Identifies and extracts the three target table types from a loaded cheerio
 * document.  Returns the extracted data arrays and detection flags for meta.
 *
 * Table roles are detected by a combination of:
 *   1. The heading text immediately preceding the table (section label).
 *   2. The keyword content of the resolved multi-level column headers.
 *
 * Tables that are clearly non-procurement (beneficial-owner declaration,
 * payment schedule, payment demand, handover act) are excluded.
 */
function classifyAndExtractTables($) {
  let itemTableInfo = null;
  let techSpecTableInfo = null;
  let deliveryTableInfo = null;
  let unifiedTableInfo = null;

  $('table').each((_, tableEl) => {
    const heading = getPrecedingHeading($, tableEl);
    const { grid, rowCount, colCount } = buildTableGrid($, tableEl);
    if (rowCount < 2 || colCount < 2) return;

    const headerRowCount = detectHeaderRowCount(grid);
    const columnDescriptors = getColumnDescriptors(grid, headerRowCount);
    const allHeaders = columnDescriptors.map((d) => d.upper).join(' ');

    // ---- Exclusions ----
    if (
      allHeaders.includes('ԻՐԱԿԱՆ ՇԱՀԱՌՈՒ') ||
      heading.includes('ԻՐԱԿԱՆ ՇԱՀԱՌՈՒ') ||
      allHeaders.includes('ՎՃԱՐՄԱՆ ԺԱՄԱՆԱԿԱՑՈՒՅՑ') ||
      heading.includes('ՎՃԱՐՄԱՆ ԺԱՄԱՆԱԿԱՑՈՒՅՑ') ||
      allHeaders.includes('ՎՃԱՐՄԱՆ ՊԱՀԱՆՋԱԳԻՐ') ||
      heading.includes('ՎՃԱՐՄԱՆ ՊԱՀԱՆՋԱԳԻՐ') ||
      allHeaders.includes('ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ') ||
      heading.includes('ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ')
    ) {
      return;
    }

    const hasName = allHeaders.includes('ԱՆՎԱՆՈՒՄ');
    const hasSpec = allHeaders.includes('ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ') || allHeaders.includes('ԲՆՈՒԹԱԳԻՐ');
    const hasDelivery = allHeaders.includes('ՄԱՏԱԿԱՐԱՐՄԱՆ') || allHeaders.includes('ԺԱՄԿԵՏ');
    const hasPrice = allHeaders.includes('ԳԻՆ');

    // Unified table (single table that combines all three sections)
    if (!unifiedTableInfo && hasName && hasSpec && (hasDelivery || hasPrice)) {
      unifiedTableInfo = { grid, headerRowCount, columnDescriptors };
    }

    // ---- Item table ----
    if (!itemTableInfo) {
      const hasItemHeaders =
        (allHeaders.includes('ԳՆՄԱՆ ԳԻՆ') || allHeaders.includes('ԳԻՆ')) &&
        (allHeaders.includes('ՉԱՓԱԲԱԺ') || allHeaders.includes('ՀԱՄԱՐ')) &&
        allHeaders.includes('ԱՆՎԱՆՈՒՄ');
      const notOther =
        !allHeaders.includes('ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ') &&
        !allHeaders.includes('ՄԱՏԱԿԱՐԱՐՄԱՆ');

      if (hasItemHeaders && notOther) {
        itemTableInfo = { grid, headerRowCount, columnDescriptors };
      }
    }

    // ---- Tech-spec table ----
    if (!techSpecTableInfo) {
      const hasTechHeaders =
        (allHeaders.includes('ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ') || allHeaders.includes('ԲՆՈՒԹԱԳԻՐ')) &&
        (allHeaders.includes('ԱՄԲՈՂՋԱԿԱՆ ԱՆՎԱՆՈՒՄ') || allHeaders.includes('ԱՆՎԱՆՈՒՄ'));

      if (hasTechHeaders) {
        techSpecTableInfo = { grid, headerRowCount, columnDescriptors };
      }
    }

    // ---- Delivery schedule table ----
    if (!deliveryTableInfo) {
      const hasDeliveryHeaders =
        (allHeaders.includes('ՄԱՏԱԿԱՐԱՐՄԱՆ') || allHeaders.includes('ԺԱՄԿԵՏ')) &&
        allHeaders.includes('ՀԱՍՑԵ') &&
        (allHeaders.includes('ՔԱՆԱԿ') || allHeaders.includes('ԵՆԹԱԿԱ'));

      if (hasDeliveryHeaders) {
        deliveryTableInfo = { grid, headerRowCount, columnDescriptors };
      }
    }
  });

  // Extract data — prefer dedicated tables, fall back to unified table
  const effectiveItem = itemTableInfo || unifiedTableInfo;
  const effectiveTech = techSpecTableInfo || unifiedTableInfo;
  const effectiveDelivery = deliveryTableInfo || unifiedTableInfo;

  const procurementItems = effectiveItem
    ? extractItemTableFromGrid(effectiveItem.grid, effectiveItem.headerRowCount, effectiveItem.columnDescriptors)
    : [];

  const technicalSpecifications = effectiveTech
    ? extractTechSpecTableFromGrid(effectiveTech.grid, effectiveTech.headerRowCount, effectiveTech.columnDescriptors)
    : [];

  const deliverySchedule = effectiveDelivery
    ? extractDeliveryTableFromGrid(effectiveDelivery.grid, effectiveDelivery.headerRowCount, effectiveDelivery.columnDescriptors)
    : [];

  return {
    procurementItems,
    technicalSpecifications,
    deliverySchedule,
    itemTableFound: Boolean(itemTableInfo || (unifiedTableInfo && procurementItems.length)),
    techSpecTableFound: Boolean(techSpecTableInfo || (unifiedTableInfo && technicalSpecifications.length)),
    deliveryTableFound: Boolean(deliveryTableInfo || (unifiedTableInfo && deliverySchedule.length)),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extracts all required fields/tables from a single hraver.docx file.
 * Returns { data, meta } where meta records which fields/tables were found,
 * for logging purposes.
 */
async function extractDocxData(filePath) {
  const rawTextResult = await mammoth.extractRawText({ path: filePath });
  const lines = rawTextResult.value.split('\n').map((l) => l.trim());

  const htmlResult = await mammoth.convertToHtml({ path: filePath });
  const $ = cheerio.load(htmlResult.value);

  const procedureCode = findLabelValue(lines, [
    'Ընթացակարգի ծածկագիրը',
    'Ընթացակարգի ծածկագիր',
  ]);
  const contractingAuthority = findLabelValue(lines, [
    'Պատվիրատու/Պատվիրատուն',
    'Պատվիրատուն',
    'Պատվիրատու',
  ]);
  const contactPerson = findContactPerson(lines);
  const section7 = extractSection7(lines);

  const {
    procurementItems,
    technicalSpecifications,
    deliverySchedule,
    itemTableFound,
    techSpecTableFound,
    deliveryTableFound,
  } = classifyAndExtractTables($);

  const data = {
    procedureCode,
    contractingAuthority,
    contactPerson: {
      name: contactPerson.name,
      phone: contactPerson.phone,
      email: contactPerson.email,
    },
    section7,
    procurementItems,
    technicalSpecifications,
    deliverySchedule,
  };

  const meta = {
    procedureCodeFound: Boolean(procedureCode),
    contractingAuthorityFound: Boolean(contractingAuthority),
    contactPersonFound: contactPerson.found,
    section7Found: Boolean(section7),
    itemTableFound,
    itemRowCount: procurementItems.length,
    techSpecTableFound,
    techSpecRowCount: technicalSpecifications.length,
    deliveryTableFound,
    deliveryRowCount: deliverySchedule.length,
  };

  return { data, meta };
}

module.exports = { extractDocxData };