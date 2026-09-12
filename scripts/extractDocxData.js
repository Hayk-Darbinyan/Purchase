'use strict';

const fs = require('fs');
const path = require('path');

const { extractDocxData } = require('../src/scraper/docxDataExtractor');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'src', 'downloads');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'docx-extraction-results.json');
const TARGET_FILENAME = 'hraver.docx';

/**
 * Recursively finds every file named "hraver.docx" (case-insensitive)
 * under rootDir. Also logs, for debugging, every directory it visits
 * and any near-miss .docx files whose name doesn't match exactly, so
 * mismatches (capitalization, double extensions, unexpected nesting)
 * are visible instead of silently producing zero results.
 */
function findHraverDocxFiles(rootDir) {
  const found = [];

  if (!fs.existsSync(rootDir)) {
    console.warn(`  Downloads directory does not exist: ${rootDir}`);
    return found;
  }

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`  Could not read directory "${dir}": ${err.message}`);
      return;
    }

    console.log(`  Scanning: ${dir} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.toLowerCase() === TARGET_FILENAME) {
          found.push(fullPath);
        } else if (entry.name.toLowerCase().endsWith('.docx')) {
          console.log(`    Note: found a .docx that doesn't match "${TARGET_FILENAME}": ${entry.name}`);
        }
      }
    }
  };

  walk(rootDir);
  return found;
}

async function run() {
  console.log(`Looking for "${TARGET_FILENAME}" files under: ${DOWNLOADS_DIR}`);
  const files = findHraverDocxFiles(DOWNLOADS_DIR);
  console.log(`Found ${files.length} file(s) to process.`);

  const results = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const folder = path.relative(DOWNLOADS_DIR, path.dirname(filePath));

    console.log(`\n=== [${i + 1}/${files.length}] ${folder} ===`);
    console.log(`File: ${filePath}`);

    try {
      const { data, meta } = await extractDocxData(filePath);

      console.log(`  Procedure code:        ${meta.procedureCodeFound ? 'FOUND' : 'not found'}`);
      console.log(`  Contracting authority: ${meta.contractingAuthorityFound ? 'FOUND' : 'not found'}`);
      console.log(`  Contact person:        ${meta.contactPersonFound ? 'FOUND' : 'not found'}`);
      console.log(`  Section 7:             ${meta.section7Found ? 'FOUND' : 'not found'}`);
      console.log(
        `  Procurement item table:      ${meta.itemTableFound ? `FOUND (${meta.itemRowCount} row(s))` : 'not found'}`
      );
      console.log(
        `  Technical spec table:        ${meta.techSpecTableFound ? `FOUND (${meta.techSpecRowCount} row(s))` : 'not found'}`
      );
      console.log(
        `  Delivery schedule table:     ${meta.deliveryTableFound ? `FOUND (${meta.deliveryRowCount} row(s))` : 'not found'}`
      );

      results.push({
        folder,
        file: filePath,
        ...data,
      });
    } catch (err) {
      console.error(`  Failed to extract: ${err.message}`);
      results.push({ folder, file: filePath, error: err.message });
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nDone. Wrote ${results.length} result(s) to ${OUTPUT_FILE}`);

  return results;
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run, findHraverDocxFiles };