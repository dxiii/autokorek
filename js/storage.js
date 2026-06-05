/**
 * @module storage
 * @description LocalStorage data management for the AutoKorek application.
 * Provides CRUD operations for answer keys, results, and settings,
 * as well as CSV and JSON export/import utilities.
 */

/** @type {string} localStorage key for answer keys */
const KEYS_STORAGE = 'autokorek_keys';

/** @type {string} localStorage key for grading results */
const RESULTS_STORAGE = 'autokorek_results';

/** @type {string} localStorage key for application settings */
const SETTINGS_STORAGE = 'autokorek_settings';

/**
 * Default application settings.
 * @type {Object}
 */
const DEFAULT_SETTINGS = {
  pgkPartialScoring: true,
  theme: 'dark',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON string from localStorage.
 *
 * @param {string} key - The localStorage key.
 * @param {*} fallback - Value to return when the key is missing or the JSON is
 *   malformed.
 * @returns {*} The parsed value or the fallback.
 */
function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Stringify and save a value to localStorage.
 *
 * @param {string} key - The localStorage key.
 * @param {*} value - The value to serialise.
 */
function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[AutoKorek] Failed to save to localStorage key "${key}":`, err);
  }
}

// ---------------------------------------------------------------------------
// Answer Key CRUD
// ---------------------------------------------------------------------------

/**
 * Save an answer key object. If a key with the same `id` exists it will be
 * updated; otherwise the key is appended.
 *
 * @param {Object} key - The answer key object (must have an `id` property).
 */
export function saveAnswerKey(key) {
  const keys = getAnswerKeys();
  const idx = keys.findIndex((k) => k.id === key.id);
  if (idx !== -1) {
    keys[idx] = key;
  } else {
    keys.push(key);
  }
  safeSet(KEYS_STORAGE, keys);
}

/**
 * Retrieve all saved answer keys.
 *
 * @returns {Object[]} Array of answer key objects.
 */
export function getAnswerKeys() {
  return safeGet(KEYS_STORAGE, []);
}

/**
 * Get a single answer key by its id.
 *
 * @param {string} id - The answer key id.
 * @returns {Object|undefined} The answer key or `undefined` if not found.
 */
export function getAnswerKeyById(id) {
  return getAnswerKeys().find((k) => k.id === id);
}

/**
 * Delete an answer key by its id.
 *
 * @param {string} id - The answer key id to delete.
 */
export function deleteAnswerKey(id) {
  const keys = getAnswerKeys().filter((k) => k.id !== id);
  safeSet(KEYS_STORAGE, keys);
}

// ---------------------------------------------------------------------------
// Results CRUD
// ---------------------------------------------------------------------------

/**
 * Save a grading result object. If a result with the same `id` exists it will
 * be updated; otherwise the result is appended.
 *
 * @param {Object} result - The grading result object (must have an `id` property).
 */
export function saveResult(result) {
  const results = getResults();
  const idx = results.findIndex((r) => r.id === result.id);
  if (idx !== -1) {
    results[idx] = result;
  } else {
    results.push(result);
  }
  safeSet(RESULTS_STORAGE, results);
}

/**
 * Retrieve all saved grading results.
 *
 * @returns {Object[]} Array of grading result objects.
 */
export function getResults() {
  return safeGet(RESULTS_STORAGE, []);
}

/**
 * Get a single grading result by its id.
 *
 * @param {string} id - The result id.
 * @returns {Object|undefined} The result or `undefined` if not found.
 */
export function getResultById(id) {
  return getResults().find((r) => r.id === id);
}

/**
 * Delete a grading result by its id.
 *
 * @param {string} id - The result id to delete.
 */
export function deleteResult(id) {
  const results = getResults().filter((r) => r.id !== id);
  safeSet(RESULTS_STORAGE, results);
}

/**
 * Remove all grading results from storage.
 */
export function clearResults() {
  safeSet(RESULTS_STORAGE, []);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Save application settings.
 *
 * @param {Object} settings - The settings object to persist.
 */
export function saveSettings(settings) {
  safeSet(SETTINGS_STORAGE, settings);
}

/**
 * Retrieve application settings, merging stored values with defaults.
 *
 * @returns {Object} The settings object.
 */
export function getSettings() {
  const stored = safeGet(SETTINGS_STORAGE, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

/**
 * Escape and quote a value for safe inclusion in a semicolon-delimited CSV
 * cell. If the value contains a semicolon, double-quote, or newline the value
 * is wrapped in double-quotes and any existing double-quotes are doubled.
 *
 * @param {*} value - The cell value.
 * @returns {string} The escaped CSV cell string.
 */
function csvCell(value) {
  const str = value == null ? '' : String(value);
  if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Export an array of grading results (associated with a single answer key) to
 * a CSV string.
 *
 * CSV format (semicolon-delimited for Indonesian-locale Excel compatibility):
 * ```
 * No;Nama Siswa;PG Benar;PG Skor;PGK Skor;Uraian Skor;Total Skor;Nilai (0-100)
 * ```
 *
 * The returned string includes a UTF-8 BOM.
 *
 * @param {Object[]} results - Array of grading result objects.
 * @param {Object} answerKey - The answer key used for these results.
 * @returns {string} The CSV content including BOM.
 */
export function exportToCSV(results, answerKey) {
  const BOM = '\uFEFF';
  const header = [
    'No',
    'Nama Siswa',
    'PG Benar',
    'PG Skor',
    'PGK Skor',
    'Uraian Skor',
    'Total Skor',
    'Nilai (0-100)',
  ].join(';');

  const rows = (results || []).map((r, index) => {
    const uraianTotal = typeof r.uraianTotal === 'number'
      ? r.uraianTotal
      : (r.uraianScores || []).reduce((sum, s) => sum + (Number(s) || 0), 0);

    return [
      index + 1,
      csvCell(r.studentName || ''),
      r.pgCorrect ?? 0,
      r.pgScore ?? 0,
      r.pgkScore ?? 0,
      uraianTotal,
      r.totalScore ?? 0,
      r.percentage ?? 0,
    ].join(';');
  });

  return BOM + [header, ...rows].join('\r\n');
}

/**
 * Export all application data (answer keys and results) as a JSON string.
 *
 * @returns {string} A JSON string containing `{ keys, results }`.
 */
export function exportAllData() {
  const data = {
    keys: getAnswerKeys(),
    results: getResults(),
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Import application data from a JSON string. Imported data is merged with
 * existing data — duplicates (by `id`) are overwritten with the imported
 * version.
 *
 * @param {string} jsonString - A JSON string previously produced by
 *   `exportAllData()`.
 * @throws {Error} If the JSON string is invalid or the data structure is
 *   unexpected.
 */
export function importData(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Format data tidak valid (JSON parse error).');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Format data tidak valid.');
  }

  // Merge answer keys
  if (Array.isArray(data.keys)) {
    const existing = getAnswerKeys();
    const merged = [...existing];
    for (const key of data.keys) {
      if (!key || !key.id) continue;
      const idx = merged.findIndex((k) => k.id === key.id);
      if (idx !== -1) {
        merged[idx] = key;
      } else {
        merged.push(key);
      }
    }
    safeSet(KEYS_STORAGE, merged);
  }

  // Merge results
  if (Array.isArray(data.results)) {
    const existing = getResults();
    const merged = [...existing];
    for (const result of data.results) {
      if (!result || !result.id) continue;
      const idx = merged.findIndex((r) => r.id === result.id);
      if (idx !== -1) {
        merged[idx] = result;
      } else {
        merged.push(result);
      }
    }
    safeSet(RESULTS_STORAGE, merged);
  }
}
