'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const {
  matchesSpecKeywords,
  hasAttachedReference,
  findHraverDocx,
  findMatchingSpecFiles,
  processZipForSpecs,
  SPEC_FILENAME_KEYWORDS,
  ATTACHMENT_KEYWORDS,
} = require('../src/bot/zipSpecExtractor');
const { mainMenuKeyboard } = require('../src/bot/botHandlers');

test('SPEC_FILENAME_KEYWORDS and ATTACHMENT_KEYWORDS contain required keywords', () => {
  assert.ok(SPEC_FILENAME_KEYWORDS.includes('bnutagir'));
  assert.ok(SPEC_FILENAME_KEYWORDS.includes('texnikakan'));
  assert.ok(SPEC_FILENAME_KEYWORDS.includes('բնութագիր'));
  assert.ok(SPEC_FILENAME_KEYWORDS.includes('տեխնիկական'));

  assert.ok(ATTACHMENT_KEYWORDS.includes('կից'));
  assert.ok(ATTACHMENT_KEYWORDS.includes('կցված'));
});

test('matchesSpecKeywords correctly identifies matching and non-matching filenames', () => {
  assert.strictEqual(matchesSpecKeywords('lot_1_i_texnikakan_bnutagir.doc'), true);
  assert.strictEqual(matchesSpecKeywords('TEXNIKAKAN_BNUTAGIR.ZIP'), true);
  assert.strictEqual(matchesSpecKeywords('ապրանքի_բնութագիր.pdf'), true);
  assert.strictEqual(matchesSpecKeywords('ՏԵԽՆԻԿԱԿԱՆ_ԱՌԱՋԱԴՐԱՆՔ.docx'), true);
  assert.strictEqual(matchesSpecKeywords('inner_bnutagir.zip'), true);

  assert.strictEqual(matchesSpecKeywords('hraver.docx'), false);
  assert.strictEqual(matchesSpecKeywords('contract.pdf'), false);
  assert.strictEqual(matchesSpecKeywords('document.zip'), false);
  assert.strictEqual(matchesSpecKeywords(''), false);
  assert.strictEqual(matchesSpecKeywords(null), false);
});

test('hasAttachedReference correctly identifies presence of կից or կցված', () => {
  // Matching cases with objects
  assert.strictEqual(
    hasAttachedReference([{ technicalSpecification: 'Տեխնիկական բնութագիրը կցված է հրավերին' }]),
    true
  );
  assert.strictEqual(
    hasAttachedReference([{ technicalSpecification: 'Տես կից ներկայացված ֆայլը' }]),
    true
  );
  assert.strictEqual(
    hasAttachedReference([{ technicalSpecification: 'Համաձայն ԿՑՎԱԾ փաստաթղթի' }]),
    true
  );
  assert.strictEqual(
    hasAttachedReference([{ technicalSpecification: 'ԿԻՑ ԲՆՈՒԹԱԳԻՐ' }]),
    true
  );

  // Matching cases with string items
  assert.strictEqual(hasAttachedReference(['կից ֆայլ']), true);
  assert.strictEqual(hasAttachedReference(['կցված փաստաթուղթ']), true);

  // Negative cases
  assert.strictEqual(
    hasAttachedReference([{ technicalSpecification: 'Նոութբուք 16GB RAM 512GB SSD Core i7' }]),
    false
  );
  assert.strictEqual(hasAttachedReference([]), false);
  assert.strictEqual(hasAttachedReference(null), false);
});

test('mainMenuKeyboard includes the new inline button for Extract Specs', () => {
  const keyboard = mainMenuKeyboard();
  const buttons = keyboard.reply_markup.inline_keyboard.flat();
  const specButton = buttons.find((btn) => btn.callback_data === 'extract_specs');

  assert.ok(specButton, 'Button with callback_data "extract_specs" must exist');
  assert.match(specButton.text, /Extract/i);
  assert.match(specButton.text, /Specs|ZIP/i);
});

test('processZipForSpecs extracts real sample archive and finds attached spec files', async () => {
  const sampleZip = path.join(__dirname, '..', 'src', 'downloads', 'tender_47435.zip');
  if (fs.existsSync(sampleZip)) {
    const result = await processZipForSpecs(sampleZip);
    assert.strictEqual(result.success, true);
    assert.ok(result.matchingFiles.length > 0);
    const hasSpecDoc = result.matchingFiles.some((f) =>
      f.includes('lot_1_i_texnikakan_bnutagir.doc')
    );
    assert.ok(hasSpecDoc, 'Should find lot_1_i_texnikakan_bnutagir.doc');
  }
});

test('processZipForSpecs handles nested zip files recursively', async () => {
  const tmpDir = path.join(__dirname, '_test_tmp_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Create a deep nested file: deep_spec.docx inside nested_bnutagir.zip
    const nestedZip = new AdmZip();
    nestedZip.addFile('inner_texnikakan_bnutagir.docx', Buffer.from('dummy docx spec content'));
    const nestedZipBuffer = nestedZip.toBuffer();

    // 2. Create middle zip: mid_bnutagir.zip containing nested_bnutagir.zip
    const midZip = new AdmZip();
    midZip.addFile('nested_bnutagir.zip', nestedZipBuffer);
    midZip.addFile('unrelated.txt', Buffer.from('hello'));
    const midZipBuffer = midZip.toBuffer();

    // 3. Create root zip containing hraver.docx (from sample) and mid_bnutagir.zip
    const sampleHraver = path.join(__dirname, '..', 'src', 'downloads', 'tender_47435', 'hraver.docx');
    if (!fs.existsSync(sampleHraver)) {
      return; // Skip if fixture is not present
    }

    const rootZip = new AdmZip();
    rootZip.addLocalFile(sampleHraver, '', 'hraver.docx');
    rootZip.addFile('texnikakan_specs.zip', midZipBuffer);
    rootZip.addFile('plain_bnutagir.pdf', Buffer.from('pdf spec'));

    const rootZipPath = path.join(tmpDir, 'test_root.zip');
    rootZip.writeZip(rootZipPath);

    // 4. Run processZipForSpecs on the root zip
    const result = await processZipForSpecs(rootZipPath);
    assert.strictEqual(result.success, true);
    assert.ok(result.matchingFiles.length >= 2, 'Should find nested and root matching files');

    const fileNames = result.matchingFiles.map((f) => path.basename(f));
    assert.ok(fileNames.includes('plain_bnutagir.pdf'));
    assert.ok(fileNames.includes('inner_texnikakan_bnutagir.docx'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('processZipForSpecs returns reason when hraver.docx is missing', async () => {
  const tmpDir = path.join(__dirname, '_test_tmp_no_hraver_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const zip = new AdmZip();
    zip.addFile('other.docx', Buffer.from('not hraver'));
    const zipPath = path.join(tmpDir, 'no_hraver.zip');
    zip.writeZip(zipPath);

    const result = await processZipForSpecs(zipPath);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'no_hraver');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('extractZip handles zip files with no extension without EEXIST collision', () => {
  const { extractZip } = require('../src/scraper/extract');
  const tmpDir = path.join(__dirname, '_test_tmp_noext_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const zip = new AdmZip();
    zip.addFile('test.txt', Buffer.from('hello'));
    const zipPathNoExt = path.join(tmpDir, 'test1');
    zip.writeZip(zipPathNoExt);

    assert.doesNotThrow(() => {
      const extractedDir = extractZip(zipPathNoExt);
      assert.ok(fs.existsSync(extractedDir));
      assert.ok(fs.existsSync(path.join(extractedDir, 'test.txt')));
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
