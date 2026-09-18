'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

function extractZip(zipPath) {
  const ext = path.extname(zipPath);
  let baseName = path.basename(zipPath, ext);
  let extractDir = path.join(path.dirname(zipPath), baseName);

  if (
    path.resolve(extractDir) === path.resolve(zipPath) ||
    (fs.existsSync(extractDir) && !fs.statSync(extractDir).isDirectory())
  ) {
    extractDir = `${extractDir}_extracted`;
  }
  fs.mkdirSync(extractDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);

  return extractDir;
}

/**
 * Lists .docx and .pdf files found (recursively) inside a directory.
 */
function listDocxAndPdfFiles(dir) {
  const docx = [];
  const pdf = [];

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.docx') docx.push(fullPath);
        else if (ext === '.pdf') pdf.push(fullPath);
      }
    }
  };
  walk(dir);

  return { docx, pdf };
}

async function readDocxText(filePath) {
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value;
}

async function readPdfText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const { text } = await pdfParse(buffer);
  return text;
}

/**
 * Extracts the ZIP and returns the raw text of every DOCX file found,
 * falling back to PDF files if there are no DOCX files.
 *
 * Returns: { extractDir, source: 'docx'|'pdf'|null, files: [{path, text}] }
 */
async function extractAndReadDocuments(zipPath) {
  const extractDir = extractZip(zipPath);
  const { docx, pdf } = listDocxAndPdfFiles(extractDir);

  if (docx.length > 0) {
    const files = await Promise.all(
      docx.map(async (filePath) => ({
        path: filePath,
        text: await readDocxText(filePath),
      }))
    );
    return { extractDir, source: 'docx', files };
  }

  if (pdf.length > 0) {
    const files = await Promise.all(
      pdf.map(async (filePath) => ({
        path: filePath,
        text: await readPdfText(filePath),
      }))
    );
    return { extractDir, source: 'pdf', files };
  }

  return { extractDir, source: null, files: [] };
}

module.exports = {
  extractZip,
  listDocxAndPdfFiles,
  readDocxText,
  readPdfText,
  extractAndReadDocuments,
};