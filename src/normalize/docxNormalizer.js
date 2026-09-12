'use strict';

/**
 * Generates a normalized DOCX from the structured data produced by
 * docxDataExtractor.js.
 *
 * The output format matches the reference "sample-tender.docx":
 *   - Title: ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ - ԳՆՄԱՆ ԺԱՄԱՆԱԿԱՑՈՒՅՑ
 *   - A single table with columns:
 *       N | Անվանումը | Տեխնիկական բնութագիրը | Չ/մ |
 *       Միավոր գինը | Ընդհանուր գինը | Քանակը | Մատակ. ժամկետը
 *   - Each procurement item maps to one row; the technical spec and
 *     delivery schedule are joined from the other arrays by lot number.
 *   - After the table, contact / procedure info is appended as plain
 *     paragraphs for reference.
 */

const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  ShadingType,
} = require('docx');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns the value of a field, or a dash when empty / null. */
function val(v) {
  return v != null && String(v).trim() !== '' ? String(v).trim() : '—';
}

/**
 * Parses numeric value from a string, handling Armenian/Russian number formatting
 * (e.g. spaces, commas as decimals, non-breaking spaces).
 */
function parseNumeric(valStr) {
  if (valStr == null) return null;
  const str = String(valStr).replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/,/g, '.').trim();
  const match = str.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = parseFloat(match[0]);
  return isNaN(num) ? null : num;
}

/**
 * Formats a number or string with a dot as thousands separator starting from the right.
 * E.g.: 1456789 -> 1.456.789, 42000000 -> 42.000.000
 * If input has decimal part (e.g. 1456.75), formats integer part with dots and preserves decimal part.
 */
function formatWithDots(rawVal) {
  if (rawVal == null) return '—';
  const rawStr = String(rawVal).trim();
  if (!rawStr || rawStr === '—') return '—';

  // Normalize spaces/non-breaking spaces
  const cleanStr = rawStr.replace(/\u00A0/g, ' ').replace(/\s+/g, '').replace(/,/g, '.');

  // Match integer part and optional decimal part
  const match = cleanStr.match(/^([-+]?\d+)(?:\.(\d+))?$/);
  if (!match) {
    // If not a pure number, try to extract numeric component
    const num = parseNumeric(rawVal);
    if (num == null) return rawStr;
    const parts = String(Math.round(num * 100) / 100).split('.');
    const intFormatted = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return parts[1] ? `${intFormatted}.${parts[1]}` : intFormatted;
  }

  const intPart = match[1];
  const decPart = match[2];
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  if (decPart !== undefined && decPart !== '') {
    return `${intFormatted}.${decPart}`;
  }
  return intFormatted;
}

/**
 * Resolves and formats unit price and total price for a row.
 * If unit price is missing, calculates total price / total quantity.
 * Both prices are formatted with dot as thousands separator.
 */
function resolveRowPrices(unitPriceRaw, totalPriceRaw, quantityRaw) {
  const totalPriceNum = parseNumeric(totalPriceRaw);
  const quantityNum = parseNumeric(quantityRaw);
  let unitPriceNum = parseNumeric(unitPriceRaw);

  if (unitPriceNum == null && totalPriceNum != null && quantityNum != null && quantityNum > 0) {
    unitPriceNum = totalPriceNum / quantityNum;
    // Round to 2 decimal places if fractional, or integer if whole
    unitPriceNum = Math.round(unitPriceNum * 100) / 100;
  }

  const formattedUnitPrice = unitPriceNum != null
    ? formatWithDots(unitPriceNum)
    : formatWithDots(unitPriceRaw);

  const formattedTotalPrice = totalPriceNum != null
    ? formatWithDots(totalPriceNum)
    : formatWithDots(totalPriceRaw);

  return { formattedUnitPrice, formattedTotalPrice };
}

/**
 * Creates a table cell with optional bold / center-aligned text and a
 * light grey fill for header rows.
 */
function makeCell(text, { bold = false, center = false, shaded = false } = {}) {
  return new TableCell({
    shading: shaded
      ? { type: ShadingType.CLEAR, color: 'D9D9D9', fill: 'D9D9D9' }
      : undefined,
    children: [
      new Paragraph({
        alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [
          new TextRun({
            text: val(text),
            bold,
            font: 'Arial',
            size: 20, // 10pt
          }),
        ],
      }),
    ],
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

// ─── public entry point ───────────────────────────────────────────────────────

/**
 * Generates a normalized DOCX buffer from extracted tender data.
 *
 * @param {object} data - The `data` object returned by extractDocxData()
 * @returns {Promise<Buffer>}
 */
async function generateNormalizedDocx(data) {
  const {
    procedureCode,
    contractingAuthority,
    contactPerson,
    section7,
    procurementItems = [],
    technicalSpecifications = [],
    deliverySchedule = [],
  } = data;

  // ── Build table rows ──────────────────────────────────────────────────────

  // Header row
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      makeCell('N', { bold: true, center: true, shaded: true }),
      makeCell('Ապրանքի անվանումը', { bold: true, center: true, shaded: true }),
      makeCell('Տեխնիկական բնութագիրը', { bold: true, center: true, shaded: true }),
      makeCell('Չ/մ', { bold: true, center: true, shaded: true }),
      makeCell('Միավոր գինը', { bold: true, center: true, shaded: true }),
      makeCell('Ընդհանուր գինը', { bold: true, center: true, shaded: true }),
      makeCell('Քանակը', { bold: true, center: true, shaded: true }),
      makeCell('Մատակ. ժամկետը', { bold: true, center: true, shaded: true }),
    ],
  });

  // Build lookup maps keyed by lot number (string)
  const specByLot = {};
  for (const spec of technicalSpecifications) {
    const key = String(spec.lotNumber || '').trim();
    if (key) specByLot[key] = spec;
  }

  const deliveryByLot = {};
  for (const del of deliverySchedule) {
    const key = String(del.lotNumber || '').trim();
    if (key) deliveryByLot[key] = del;
  }

  // Data rows — one per procurement item
  const dataRows = procurementItems.map((item, idx) => {
    const lotKey = String(item.lotNumber || '').trim();
    const spec = specByLot[lotKey] || {};
    const delivery = deliveryByLot[lotKey] || {};

    // Technical spec: prefer the detailed field from the spec table
    const techSpec = spec.technicalSpecification || '—';

    // Calculate unit price if missing and format both prices with dot thousands separators
    const { formattedUnitPrice, formattedTotalPrice } = resolveRowPrices(
      item.unitPrice,
      item.price,
      delivery.totalQuantity
    );

    return new TableRow({
      children: [
        makeCell(String(idx + 1), { center: true }),
        makeCell(item.itemName),
        makeCell(techSpec),
        makeCell(delivery.unit),
        makeCell(formattedUnitPrice),
        makeCell(formattedTotalPrice),
        makeCell(delivery.totalQuantity),
        makeCell(delivery.deadline),
      ],
    });
  });

  // If no procurement items but we have tech specs (e.g. unified table only)
  if (dataRows.length === 0 && technicalSpecifications.length > 0) {
    technicalSpecifications.forEach((spec, idx) => {
      const lotKey = String(spec.lotNumber || '').trim();
      const delivery = deliveryByLot[lotKey] || {};

      const { formattedUnitPrice, formattedTotalPrice } = resolveRowPrices(
        spec.unitPrice,
        spec.price,
        delivery.totalQuantity
      );

      dataRows.push(
        new TableRow({
          children: [
            makeCell(String(idx + 1), { center: true }),
            makeCell(spec.fullName),
            makeCell(spec.technicalSpecification),
            makeCell(delivery.unit),
            makeCell(formattedUnitPrice),
            makeCell(formattedTotalPrice),
            makeCell(delivery.totalQuantity),
            makeCell(delivery.deadline),
          ],
        })
      );
    });
  }

  // ── Build document ────────────────────────────────────────────────────────

  const children = [
    // Title
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: 'ՏԵԽՆԻԿԱԿԱՆ ԲՆՈՒԹԱԳԻՐ - ԳՆՄԱՆ ԺԱՄԱՆԱԿԱՑՈՒՅՑ',
          bold: true,
          font: 'Arial',
          size: 24, // 12pt
        }),
      ],
      spacing: { after: 200 },
    }),

    // Main table
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow, ...dataRows],
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
        left: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
        right: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
        insideH: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
        insideV: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
      },
    }),

    // Spacer
    new Paragraph({ text: '', spacing: { after: 200 } }),

    // ── Meta section ─────────────────────────────────────────────────────────
    ...(procedureCode
      ? [
          new Paragraph({
            children: [
              new TextRun({ text: 'Ընթացակարգի ծածկագիր: ', bold: true, font: 'Arial', size: 20 }),
              new TextRun({ text: val(procedureCode), font: 'Arial', size: 20 }),
            ],
          }),
        ]
      : []),

    ...(contractingAuthority
      ? [
          new Paragraph({
            children: [
              new TextRun({ text: 'Պատվիրատու: ', bold: true, font: 'Arial', size: 20 }),
              new TextRun({ text: val(contractingAuthority), font: 'Arial', size: 20 }),
            ],
          }),
        ]
      : []),

    ...(contactPerson && (contactPerson.name || contactPerson.phone || contactPerson.email)
      ? [
          new Paragraph({
            children: [
              new TextRun({ text: 'Կոնտակտ անձ: ', bold: true, font: 'Arial', size: 20 }),
              new TextRun({
                text: [
                  contactPerson.name,
                  contactPerson.phone,
                  contactPerson.email,
                ]
                  .filter(Boolean)
                  .join(' | '),
                font: 'Arial',
                size: 20,
              }),
            ],
          }),
        ]
      : []),

    ...(section7
      ? [
          new Paragraph({ text: '', spacing: { after: 100 } }),
          new Paragraph({
            children: [
              new TextRun({ text: section7, font: 'Arial', size: 20 }),
            ],
          }),
        ]
      : []),
  ];

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generateNormalizedDocx };
