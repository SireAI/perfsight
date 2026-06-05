const TOTAL_PSS_RE = /TOTAL PSS:\s+(\d+)/;
const APP_SUMMARY_LINE_RE = /^\s*([A-Za-z0-9 .()/+-]+):/;
const OBJECT_PAIR_RE = /([A-Za-z][A-Za-z0-9 ]*[A-Za-z0-9]):\s+(\d+)/g;

export function normalizeLabel(label) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function parseMeminfoObjects(output) {
  const objects = {};
  let inObjects = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const stripped = rawLine.trim();
    if (stripped === 'Objects') {
      inObjects = true;
      continue;
    }
    if (!inObjects) continue;
    if (stripped && !rawLine.startsWith(' ')) break;
    for (const match of rawLine.matchAll(OBJECT_PAIR_RE)) {
      objects[normalizeLabel(match[1])] = Number(match[2]);
    }
  }
  return objects;
}

export function parseMeminfoPss(output) {
  const totalMatch = TOTAL_PSS_RE.exec(output);
  let totalPssKb = totalMatch ? Number(totalMatch[1]) : null;
  const breakdownKb = {};
  const objects = parseMeminfoObjects(output);
  let inAppSummary = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const stripped = line.trim();
    if (stripped === 'App Summary') {
      inAppSummary = true;
      continue;
    }
    if (!inAppSummary) continue;
    if (stripped.startsWith('Objects') || stripped.startsWith('SQL')) break;
    const match = APP_SUMMARY_LINE_RE.exec(line);
    if (!match) continue;
    const label = normalizeLabel(match[1]);
    const tail = line.split(':').slice(1).join(':');
    const pssField = tail.slice(0, 16).trim();
    if (!/^\d+$/.test(pssField)) continue;
    const value = Number(pssField);
    if (label === 'total' || label === 'total_pss') {
      totalPssKb = value;
    } else {
      breakdownKb[label] = value;
    }
  }
  if (totalPssKb !== null && breakdownKb.unknown === undefined) {
    const known = Object.values(breakdownKb).reduce((sum, value) => sum + value, 0);
    if (totalPssKb > known) breakdownKb.unknown = totalPssKb - known;
  }
  return { totalPssKb, breakdownKb, objects };
}
