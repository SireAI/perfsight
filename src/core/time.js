export function nowSeconds() {
  return Date.now() / 1000;
}

export function isoFromSeconds(seconds) {
  return new Date(seconds * 1000).toISOString();
}

export function timestampStamp(seconds = nowSeconds()) {
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
