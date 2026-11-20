/**
 * The server stores all timestamps as SQLite `datetime('now')` strings —
 * always UTC, but formatted as "YYYY-MM-DD HH:MM:SS" with no timezone
 * marker. JavaScript's `new Date(...)` parses that space-separated,
 * marker-less form as LOCAL time, not UTC, which silently produced wrong
 * times whenever the viewer's browser wasn't already on UTC. Every date
 * from the API must go through `parseServerDate` before display.
 *
 * The dashboard is for an India-based company, so times are always shown
 * in IST regardless of the viewing browser's own timezone, using the
 * explicit `Asia/Kolkata` IANA zone rather than relying on browser locale.
 */
export function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // Already has a timezone marker (Z or +hh:mm) — use as-is. Otherwise the
  // value is a bare "YYYY-MM-DD HH:MM:SS" UTC string from SQLite; normalize
  // it to ISO 8601 and mark it UTC explicitly.
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(value.trim());
  const iso = hasTz ? value : value.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

const IST_DATETIME: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true
};

const IST_DATE: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
};

/** Formats a server timestamp as an IST date+time string, e.g. "28/09/2026, 12:28:55 pm". */
export function formatIST(value: string | null | undefined, fallback = '—'): string {
  const d = parseServerDate(value);
  if (!d) return fallback;
  return d.toLocaleString('en-IN', IST_DATETIME) + ' IST';
}

/** Whole days since a server timestamp (null if never). */
export function daysSince(value: string | null | undefined): number | null {
  const d = parseServerDate(value);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/** Formats a server timestamp as an IST date only, e.g. "28/09/2026". */
export function formatISTDate(value: string | null | undefined, fallback = '—'): string {
  const d = parseServerDate(value);
  if (!d) return fallback;
  return d.toLocaleDateString('en-IN', IST_DATE);
}
