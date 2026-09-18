'use strict';

/**
 * Persists the list of keyword-matched tenders that are relevant to the
 * Գնումներ (procurement) management flow.
 *
 * Storage:
 *   data/procurement-tenders.json  — array of matched tender records
 *
 * Each record:
 * {
 *   id:                 string   — unique key derived from tender link
 *   name:               string
 *   link:               string
 *   date:               string|null   — publication date from listing (existing field)
 *   startDate:          string|null   — publication date from tender page
 *   endDate:            string|null   — submission deadline from tender page
 *   price:              number|null   — total tender price (AMD)
 *   normalizedDocxPath: string|null   — absolute path to saved normalized .docx
 *   addedAt:            string        — ISO timestamp when record was added
 *   submittedAt:        string|null   — ISO timestamp when marked as submitted; null otherwise
 * }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'procurement-tenders.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derives a stable ID from a tender link.
 */
function tenderIdFromLink(link) {
  if (!link) return String(Date.now());
  const match = link.match(/tmid\/([\w-]+)/i);
  if (match) return match[1];
  return link.replace(/[^a-zA-Z0-9]/g, '_').slice(-60);
}

// ── I/O ───────────────────────────────────────────────────────────────────────

function loadAll() {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(records) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(records, null, 2), 'utf-8');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Adds (or updates) a matched tender record in the store.
 */
function upsertTender({ name, link, date, startDate, endDate, price, normalizedDocxPath }) {
  const records = loadAll();
  const id = tenderIdFromLink(link);

  const existingIdx = records.findIndex((r) => r.id === id);
  if (existingIdx !== -1) {
    const existing = records[existingIdx];
    records[existingIdx] = {
      ...existing,
      name,
      link,
      date: date ?? existing.date,
      startDate: startDate ?? existing.startDate,
      endDate: endDate ?? existing.endDate,
      price: price ?? existing.price,
      normalizedDocxPath: normalizedDocxPath ?? existing.normalizedDocxPath,
    };
    saveAll(records);
    return records[existingIdx];
  }

  const record = {
    id,
    name,
    link,
    date: date ?? null,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    price: price ?? null,
    normalizedDocxPath: normalizedDocxPath ?? null,
    addedAt: new Date().toISOString(),
    submittedAt: null,
  };
  records.push(record);
  saveAll(records);
  return record;
}

/**
 * Marks a tender as "submitted" so deadline notifications stop.
 */
function markSubmitted(id) {
  const records = loadAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  records[idx].submittedAt = new Date().toISOString();
  saveAll(records);
  return true;
}

/**
 * Returns all procurement tender records.
 */
function getAllTenders() {
  return loadAll();
}

/**
 * Returns a single record by id, or null.
 */
function getTenderById(id) {
  return loadAll().find((r) => r.id === id) || null;
}

// ── Price helpers ─────────────────────────────────────────────────────────────

const PRICE_RANGES = [
  { key: 'r0', label: 'մինչև 1.000.000',  min: 0,          max: 1_000_000 },
  { key: 'r1', label: 'մինչև 10.000.000', min: 1_000_000,  max: 10_000_000 },
  { key: 'r2', label: 'մինչև 85.000.000', min: 10_000_000, max: 85_000_000 },
  { key: 'r3', label: '85.000.000 ավել',  min: 85_000_000, max: Infinity },
];

/**
 * Returns the PRICE_RANGES entry that the given numeric price falls into,
 * or null when price is null/unknown.
 */
function priceRangeFor(price) {
  if (price == null || typeof price !== 'number' || isNaN(price)) return null;
  if (price <= 1_000_000) return PRICE_RANGES[0];
  if (price <= 10_000_000) return PRICE_RANGES[1];
  if (price <= 85_000_000) return PRICE_RANGES[2];
  return PRICE_RANGES[3];
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Parses an ISO / "YYYY-MM-DD HH:mm:ss" date string to a Date, or null.
 */
function parseDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (m) {
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = m;
    const dt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(str);
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Returns whether deadline is already overdue.
 */
function isOverdue(endDateStr) {
  const deadline = parseDate(endDateStr);
  if (!deadline) return false;
  return deadline.getTime() < Date.now();
}

/**
 * Returns the number of whole calendar days from today until deadline.
 * Returns negative if deadline has already passed.
 */
function daysUntilDeadline(endDateStr) {
  const deadline = parseDate(endDateStr);
  if (!deadline) return null;
  if (deadline.getTime() < Date.now()) {
    return -1;
  }
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const deadlineStart = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  const diffDays = Math.round((deadlineStart - todayStart) / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

module.exports = {
  upsertTender,
  markSubmitted,
  getAllTenders,
  getTenderById,
  tenderIdFromLink,
  PRICE_RANGES,
  priceRangeFor,
  parseDate,
  isOverdue,
  daysUntilDeadline,
};
