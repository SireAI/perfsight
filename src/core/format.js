export function roundOrNull(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return Number(value).toFixed(digits);
}

export function sanitizePackageName(packageName) {
  return String(packageName).replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/\./g, '_');
}

export function jsonLine(value) {
  return JSON.stringify(value, null, 2);
}
