'use strict';

/**
 * Extracts values from the `Տեխնիկական բնութագիր` column of a spec file.
 *
 * Supports:
 *  - XLSX (Office Open XML Spreadsheet) — parsed via AdmZip + cheerio
 *  - DOCX (Office Open XML Document)   — parsed via existing extractDocxData
 *
 * Returns an ordered array of non-empty string values from the column.
 * Returns an empty array when the column is not found or parsing fails.
 */

const path = require('path');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');

const { extractDocxData } = require('../scraper/docxDataExtractor');
const logger = require('../logger');

// ---------------------------------------------------------------------------
// Generic helpers (mirrors docxDataExtractor.js)
// ---------------------------------------------------------------------------

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Returns true if `haystack` contains the `needle` (case-insensitive,
 * collapsed whitespace), matching the same approach used in the DOCX extractor.
 */
function includesUpper(haystack, needle) {
  return normalizeText(haystack).toUpperCase().includes(normalizeText(needle).toUpperCase());
}

/**
 * Returns true when the cell text matches the `Տեխնիկական բնութագիր` column,
 * using the same fallback chain as `extractTechSpecTableFromGrid` in
 * docxDataExtractor.js:
 *   1. Full match: "ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ"
 *   2. Fallback:   "ԲՆՈՒԹԱԳԻՐ"
 */
function isTechSpecHeader(cellText) {
  const up = normalizeText(cellText).toUpperCase();
  return up.includes('ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ') || up.includes('ԲՆՈՒԹԱԳԻՐ');
}

// ---------------------------------------------------------------------------
// XLSX extraction
// ---------------------------------------------------------------------------

/**
 * Converts an A1-style column string (e.g. "AB") to a 0-based column index.
 */
function colLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/**
 * Parses an A1-style cell reference (e.g. "D5") into { col, row } (0-based).
 */
function parseCellRef(ref) {
  const m = (ref || '').match(/^([A-Z]+)(\d+)$/i);
  if (!m) return { col: -1, row: -1 };
  return { col: colLettersToIndex(m[1].toUpperCase()), row: parseInt(m[2], 10) - 1 };
}

/**
 * Extracts the shared-strings table from an XLSX zip as a plain Array<string>.
 */
function readSharedStrings(zip) {
  const strings = [];
  const entry = zip.getEntry('xl/sharedStrings.xml');
  if (!entry) return strings;

  const xml = zip.readAsText(entry);
  const $sst = cheerio.load(xml, { xmlMode: true });
  $sst('si').each((_, si) => {
    let text = '';
    $sst(si).find('t').each((__, t) => {
      text += $sst(t).text();
    });
    strings.push(text);
  });
  return strings;
}

/**
 * Reads one worksheet from an XLSX zip into a 2D grid (Array of Array of string).
 * Uses the shared-strings table for string cells.
 */
function readSheetGrid(zip, sheetEntry, strings) {
  const xml = zip.readAsText(sheetEntry);
  const $sheet = cheerio.load(xml, { xmlMode: true });
  const grid = [];

  $sheet('row').each((_, rowEl) => {
    $sheet(rowEl).find('c').each((__, cEl) => {
      const rAttr = $sheet(cEl).attr('r');
      if (!rAttr) return;
      const { col, row } = parseCellRef(rAttr);
      if (row < 0 || col < 0) return;

      if (!grid[row]) grid[row] = [];

      const t = $sheet(cEl).attr('t');
      let val = '';

      if (t === 's') {
        const idx = parseInt($sheet(cEl).find('v').text(), 10);
        val = Number.isNaN(idx) ? '' : (strings[idx] || '');
      } else if (t === 'inlineStr') {
        val = $sheet(cEl).find('is t').text() || '';
      } else {
        val = $sheet(cEl).find('v').text() || '';
      }

      grid[row][col] = normalizeText(val);
    });
  });

  return grid;
}

/**
 * Locates the `Տեխնիկական բնութագիր` column in the header area of a grid
 * (searches the first 10 rows).
 *
 * Returns { specCol, startRow } or { specCol: -1, startRow: -1 } when not found.
 */
function findSpecColumn(grid) {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    if (!grid[r]) continue;
    for (let c = 0; c < grid[r].length; c++) {
      if (isTechSpecHeader(grid[r][c] || '')) {
        return { specCol: c, startRow: r + 1 };
      }
    }
  }
  return { specCol: -1, startRow: -1 };
}

/**
 * Extracts all non-empty values from the tech-spec column of an XLSX file,
 * preserving row order.
 *
 * @param {string} filePath - Absolute path to the .xlsx file
 * @returns {string[]}
 */
function extractTechSpecsFromXlsx(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const strings = readSharedStrings(zip);

    const sheetEntries = zip.getEntries().filter((e) =>
      /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.entryName)
    );

    const allSpecs = [];

    for (const sheetEntry of sheetEntries) {
      const grid = readSheetGrid(zip, sheetEntry, strings);
      const { specCol, startRow } = findSpecColumn(grid);

      if (specCol === -1) continue;

      for (let r = startRow; r < grid.length; r++) {
        const val = (grid[r] && grid[r][specCol]) ? grid[r][specCol] : '';
        if (!val) continue;

        // Skip obvious footer/total rows
        const up = val.toUpperCase();
        if (
          up.includes('ԸՆԴԱՄԵՆԸ') ||
          up.includes('ԳՆՈՐԴ') ||
          up.includes('ՎԱՃԱՌՈՂ') ||
          isTechSpecHeader(val)
        ) continue;

        allSpecs.push(val);
      }
    }

    return allSpecs;
  } catch (err) {
    logger.warn('Failed to extract tech specs from XLSX', { filePath, error: err.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// DOCX extraction
// ---------------------------------------------------------------------------

/**
 * Extracts all `technicalSpecification` values from a DOCX file using the
 * existing `extractDocxData` function (which drives the main hraver.docx
 * extraction pipeline).
 *
 * @param {string} filePath - Absolute path to the .docx file
 * @returns {Promise<string[]>}
 */
async function extractTechSpecsFromDocx(filePath) {
  try {
    const { data } = await extractDocxData(filePath);
    const specs = [];

    const rows = data.technicalSpecifications && data.technicalSpecifications.length
      ? data.technicalSpecifications
      : (data.procurementItems || []);

    for (const row of rows) {
      const val = typeof row === 'string'
        ? row
        : normalizeText(row.technicalSpecification || '');
      if (val) specs.push(val);
    }

    return specs;
  } catch (err) {
    logger.warn('Failed to extract tech specs from DOCX', { filePath, error: err.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extracts `Տեխնիկական բնութագիր` values from a matching spec file.
 *
 * Supported formats: .xlsx, .docx
 * Unsupported formats (e.g. .doc, .pdf): returns []
 *
 * @param {string} filePath
 * @returns {Promise<string[]>}
 */
async function extractTechSpecsFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx') {
    return extractTechSpecsFromXlsx(filePath);
  }

  if (ext === '.docx') {
    return extractTechSpecsFromDocx(filePath);
  }

  // .doc (OLE format), .pdf, and others are not parseable here
  return [];
}

module.exports = { extractTechSpecsFromFile };
