/**
 * @module utils
 * @description Helper utilities for the AutoKorek application.
 */

/**
 * Indonesian month names used for date formatting.
 * @type {string[]}
 */
const INDONESIAN_MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

/**
 * Emoji icons mapped to toast notification types.
 * @type {Object<string, string>}
 */
const TOAST_ICONS = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

/**
 * Generate a UUID v4 string.
 * Uses crypto.randomUUID() when available, otherwise falls back to a
 * manual implementation using crypto.getRandomValues().
 *
 * @returns {string} A UUID v4 string (e.g. "550e8400-e29b-41d4-a716-446655440000").
 */
export function generateId() {
  // Prefer the native API when available
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback: manual UUID v4 generation
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // Last-resort fallback using Math.random (less secure but functional)
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Set version (4) and variant (RFC 4122) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Format a Date object to Indonesian locale format.
 *
 * @param {Date} date - The Date object to format.
 * @returns {string} Formatted date string, e.g. "5 Juni 2025, 08:30".
 */
export function formatDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }

  const day = date.getDate();
  const month = INDONESIAN_MONTHS[date.getMonth()];
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${day} ${month} ${year}, ${hours}:${minutes}`;
}

/**
 * Show a toast notification that auto-dismisses after 3 seconds.
 *
 * Creates a `<div>` with class `toast toast-{type}`, appends it to the
 * `#toast-container` element, and removes it after 3 seconds.
 *
 * @param {string} message - The message to display.
 * @param {'success'|'error'|'info'|'warning'} [type='info'] - The toast type.
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) {
    // eslint-disable-next-line no-console
    console.warn('[AutoKorek] #toast-container not found in the DOM.');
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = TOAST_ICONS[type] || TOAST_ICONS.info;

  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message">${message}</span>`;

  container.appendChild(toast);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    // Fade-out by adding a class (CSS can hook into this)
    toast.classList.add('toast-exit');

    // Remove from DOM after a short transition window
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, 3000);
}

/**
 * Create a debounced version of a function.
 *
 * The returned function delays invoking `fn` until after `delay` milliseconds
 * have elapsed since the last time it was called.
 *
 * @param {Function} fn - The function to debounce.
 * @param {number} [delay=300] - Delay in milliseconds.
 * @returns {Function} The debounced function.
 */
export function debounce(fn, delay = 300) {
  let timer = null;

  return function debounced(...args) {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn.apply(this, args);
      timer = null;
    }, delay);
  };
}

/**
 * Trigger haptic feedback on mobile devices via the Vibration API.
 *
 * Silently does nothing when the API is unavailable (e.g. desktop browsers).
 *
 * @param {number|number[]} [pattern=[50]] - Vibration pattern in milliseconds.
 */
export function vibrate(pattern = [50]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Vibration API may throw in some environments; silently ignore.
    }
  }
}
