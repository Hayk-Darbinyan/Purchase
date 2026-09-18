'use strict';

/**
 * Handles ZIP extraction, hraver.docx inspection, and searching for
 * attached technical specification files according to user specifications:
 *
 * 1. Extract the ZIP using existing ZIP extraction functionality (extractZip).
 * 2. Find hraver.docx inside the extracted files.
 * 3. Use existing DOCX extraction functionality (extractDocxData) to get
 *    the technical specification values from hraver.docx.
 * 4. Check the extracted technical specification values. If at least one value
 *    contains either:
 *      - "կից"
 *      - "կցված"
 * 5. Search through the extracted ZIP contents for other files whose filename
 *    contains any of these keywords:
 *      - "bnutagir"
 *      - "texnikakan"
 *      - "բնութագիր"
 *      - "տեխնիկական"
 * 6. Matching files can themselves be ZIP files. If a matching file is a ZIP,
 *    extract it and continue searching inside it for files whose names contain
 *    the same keywords.
 * 7. Continue this process through nested ZIP files until all relevant files
 *    have been checked.
 * 8. Return/send the found matching file(s).
 */

const path = require('path');
const fs = require('fs');

const { extractZip } = require('../scraper/extract');
const { extractDocxData } = require('../scraper/docxDataExtractor');
const { extractTechSpecsFromFile } = require('./specFileDataExtractor');
const logger = require('../logger');

const SPEC_FILENAME_KEYWORDS = ['bnutagir', 'texnikakan', 'բնութագիր', 'տեխնիկական'];
const ATTACHMENT_KEYWORDS = ['կից', 'կցված'];

/**
 * Checks if a filename matches any of the required specification keywords.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function matchesSpecKeywords(filename) {
  const lower = (filename || '').toLowerCase();
  return SPEC_FILENAME_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Checks if at least one technical specification value contains "կից" or "կցված".
 *
 * @param {Array<{technicalSpecification?: string}|string>} technicalSpecifications
 * @returns {boolean}
 */
function hasAttachedReference(technicalSpecifications) {
  if (!Array.isArray(technicalSpecifications) || !technicalSpecifications.length) {
    return false;
  }

  return technicalSpecifications.some((item) => {
    const text = typeof item === 'string'
      ? item
      : `${item?.technicalSpecification || ''} ${item?.fullName || ''} ${item?.itemName || ''}`;
    const lower = text.toLowerCase();
    return ATTACHMENT_KEYWORDS.some((kw) => lower.includes(kw));
  });
}

/**
 * Recursively locates `hraver.docx` inside an extracted directory.
 *
 * @param {string} dir
 * @returns {string|null} Full path to hraver.docx or null
 */
function findHraverDocx(dir) {
  let found = null;
  function walk(current) {
    if (found || !fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.toLowerCase() === 'hraver.docx') {
          found = full;
          return;
        }
      }
    }
  }
  walk(dir);
  return found;
}

/**
 * Lists all non-zip files in a directory recursively.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listAllNonZipFiles(dir) {
  const result = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && !entry.name.toLowerCase().endsWith('.zip')) {
        result.push(p);
      }
    }
  }
  walk(dir);
  return result;
}

/**
 * Recursively searches through the extracted contents for matching files,
 * expanding any nested ZIP archives (whether matching or contained).
 *
 * @param {string} searchDir
 * @param {Set<string>} [processedZips]
 * @returns {string[]} Matching file paths
 */
function findMatchingSpecFiles(searchDir, processedZips = new Set()) {
  const matchingFiles = [];

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();

        // Skip hraver documents from being considered as separate spec attachments
        if (lowerName === 'hraver.docx' || lowerName === 'hraver_ru.docx') {
          continue;
        }

        const isZip = lowerName.endsWith('.zip');
        const matches = matchesSpecKeywords(entry.name);

        if (isZip) {
          if (!processedZips.has(fullPath)) {
            processedZips.add(fullPath);
            try {
              const extractedChildDir = extractZip(fullPath);
              const childMatches = findMatchingSpecFiles(extractedChildDir, processedZips);
              if (childMatches.length > 0) {
                matchingFiles.push(...childMatches);
              } else if (matches) {
                // If the ZIP itself was named like a spec, but files inside didn't repeat the keyword,
                // include the unpacked files inside it
                const childFiles = listAllNonZipFiles(extractedChildDir);
                if (childFiles.length > 0) {
                  matchingFiles.push(...childFiles);
                } else {
                  matchingFiles.push(fullPath);
                }
              }
            } catch (err) {
              logger.warn('Failed to extract nested ZIP', { path: fullPath, error: err.message });
              if (matches) {
                matchingFiles.push(fullPath);
              }
            }
          }
        } else if (matches) {
          matchingFiles.push(fullPath);
        }
      }
    }
  }

  walk(searchDir);
  return [...new Set(matchingFiles)];
}

/**
 * Orchestrates the full process for an uploaded tender ZIP archive.
 *
 * @param {string} zipPath - Local path to the uploaded ZIP file
 * @returns {Promise<{
 *   success: boolean,
 *   reason?: 'no_hraver' | 'no_attachment_ref' | 'no_matching_files',
 *   message?: string,
 *   hraverPath?: string,
 *   extractedDir?: string,
 *   matchingFiles?: string[],
 *   matchingFilesWithSpecs?: Array<{ filePath: string, techSpecs: string[] }>,
 *   techSpecsCount?: number
 * }>}
 */
async function processZipForSpecs(zipPath) {
  // 1. Extract the ZIP using existing ZIP extraction functionality
  const extractedDir = extractZip(zipPath);

  // 2. Find hraver.docx inside the extracted files
  const hraverPath = findHraverDocx(extractedDir);
  if (!hraverPath) {
    return {
      success: false,
      reason: 'no_hraver',
      message: 'Could not find "hraver.docx" inside the ZIP archive.',
      extractedDir,
    };
  }

  // 3. Use existing DOCX extraction functionality to get technical specification values
  const { data } = await extractDocxData(hraverPath);
  const techSpecs = (data.technicalSpecifications && data.technicalSpecifications.length > 0)
    ? data.technicalSpecifications
    : (data.procurementItems || []);

  // 4. Check if at least one value contains "կից" or "կցված"
  const hasRef = hasAttachedReference(techSpecs);
  if (!hasRef) {
    return {
      success: false,
      reason: 'no_attachment_ref',
      message: 'Technical specifications in hraver.docx do not contain references to attached files (no "կից" or "կցված" found).',
      hraverPath,
      extractedDir,
      techSpecsCount: techSpecs.length,
    };
  }

  // 5, 6, 7. Search through extracted ZIP contents (including nested ZIPs) for matching files
  const matchingFiles = findMatchingSpecFiles(extractedDir);
  if (!matchingFiles.length) {
    return {
      success: false,
      reason: 'no_matching_files',
      message: 'Technical specifications indicate attached files, but no files containing "bnutagir", "texnikakan", "բնութագիր", or "տեխնիկական" were found.',
      hraverPath,
      extractedDir,
      matchingFiles: [],
      matchingFilesWithSpecs: [],
      techSpecsCount: techSpecs.length,
    };
  }

  // 8. For each matching file, extract the Տեխնիկական բնութագիր column values
  const matchingFilesWithSpecs = await Promise.all(
    matchingFiles.map(async (filePath) => {
      const fileSpecs = await extractTechSpecsFromFile(filePath);
      return { filePath, techSpecs: fileSpecs };
    })
  );

  return {
    success: true,
    hraverPath,
    extractedDir,
    matchingFiles,
    matchingFilesWithSpecs,
    techSpecsCount: techSpecs.length,
  };
}

module.exports = {
  SPEC_FILENAME_KEYWORDS,
  ATTACHMENT_KEYWORDS,
  matchesSpecKeywords,
  hasAttachedReference,
  findHraverDocx,
  findMatchingSpecFiles,
  processZipForSpecs,
};
