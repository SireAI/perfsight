const STAT_RE = /^(?<pid>\d+)\s+\((?<comm>.*)\)\s+(?<rest>.+)$/;

export function parseProcStatLine(line) {
  const match = STAT_RE.exec(line.trim());
  if (!match) return null;
  const rest = match.groups.rest.split(/\s+/);
  if (rest.length < 15) return null;
  return {
    pid: Number(match.groups.pid),
    utime: Number(rest[11]),
    stime: Number(rest[12])
  };
}

export function parseCpuTotals(line) {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== 'cpu') {
    throw new Error('unexpected /proc/stat format');
  }
  const values = parts.slice(1).map(Number).filter(Number.isFinite);
  const idle = values[3] + (values[4] || 0);
  return { total: values.reduce((sum, value) => sum + value, 0), idle };
}

export function parseTopCpuPct(output, pids) {
  const pidSet = new Set(pids.map(String));
  let cpuIndex = null;
  let total = 0;
  let found = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.includes('PID') && parts.some((token) => token.includes('%CPU') || token.includes('CPU%'))) {
      cpuIndex = parts.findIndex((token) => token === '%CPU' || token === 'CPU%' || token.includes('%CPU') || token.includes('CPU%'));
      continue;
    }
    if (!parts.some((part) => pidSet.has(part))) continue;
    const candidates = [];
    if (cpuIndex !== null && cpuIndex >= 0 && cpuIndex < parts.length) candidates.push(parts[cpuIndex]);
    candidates.push(...parts);
    for (const candidate of candidates) {
      const value = Number(candidate.replace(/^\[/, '').replace(/\]$/, '').replace(/%$/, ''));
      if (Number.isFinite(value) && value >= 0 && value <= 1000) {
        total += value;
        found = true;
        break;
      }
    }
  }
  return found ? total : null;
}
