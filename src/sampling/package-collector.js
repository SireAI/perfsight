import { nowSeconds } from '../core/time.js';
import { parseCpuTotals, parseProcStatLine, parseTopCpuPct } from '../parsers/proc.js';
import { parseMeminfoPss } from '../parsers/meminfo.js';

export class PackageCollector {
  constructor({ adb, packageName, pssIntervalSec }) {
    this.adb = adb;
    this.packageName = packageName;
    this.pssIntervalSec = Math.max(0, Number(pssIntervalSec) || 0);
    this.lastPssAt = 0;
    this.lastPssKb = null;
    this.lastBreakdownKb = {};
    this.lastObjects = {};
  }

  resetRuntimeCache() {
    this.lastPssAt = 0;
    this.lastPssKb = null;
    this.lastBreakdownKb = {};
    this.lastObjects = {};
  }

  async snapshot() {
    const pids = await this.getPids();
    const { total, idle } = await this.readCpuTotals();
    if (pids.length === 0) {
      return {
        timestamp: nowSeconds(),
        totalCpu: total,
        idleCpu: idle,
        processTimes: [],
        topCpuPct: null,
        cpuSource: 'unavailable',
        rssKb: 0,
        pssKb: null,
        pssBreakdownKb: {},
        meminfoObjects: {},
        pids: []
      };
    }

    const processTimes = await this.readProcessTimes(pids);
    let topCpuPct = null;
    let cpuSource = 'proc';
    if (processTimes.length === 0) {
      topCpuPct = await this.readTopCpuPct(pids);
      cpuSource = topCpuPct === null ? 'unavailable' : 'top';
    }
    const [rssKb, pss] = await Promise.all([
      this.readRssKb(pids),
      this.maybeRefreshPss(false)
    ]);
    return {
      timestamp: nowSeconds(),
      totalCpu: total,
      idleCpu: idle,
      processTimes,
      topCpuPct,
      cpuSource,
      rssKb,
      pssKb: pss.pssKb,
      pssBreakdownKb: pss.breakdownKb,
      meminfoObjects: pss.objects,
      pids: processTimes.map((proc) => proc.pid).length ? processTimes.map((proc) => proc.pid) : pids
    };
  }

  async getPids() {
    const pidof = (await this.adb.shell(`pidof ${this.packageName}`, { check: false })).trim();
    if (pidof) {
      const pids = pidof.split(/\s+/).map(Number).filter(Number.isInteger);
      const mainPids = await this.filterMainProcessPids(pids);
      if (mainPids.length) return mainPids.slice(0, 1);
    }
    const ps = await this.adb.shell('ps -A', { check: false });
    const matches = [];
    for (const line of ps.split(/\r?\n/)) {
      if (!line.includes(this.packageName)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.at(-1) !== this.packageName) continue;
      const pid = Number(parts[1]);
      if (Number.isInteger(pid)) matches.push(pid);
    }
    return matches.slice(0, 1);
  }

  async filterMainProcessPids(pids) {
    if (!pids.length) return [];
    const script = pids.map((pid) => `printf '%s ' ${pid}; cat /proc/${pid}/cmdline 2>/dev/null; printf '\\n'`).join('; ');
    const output = await this.adb.shell(script, { check: false });
    const result = [];
    for (const line of output.split(/\r?\n/)) {
      const [pidText, ...rest] = line.split(' ');
      const pid = Number(pidText);
      const cmdline = rest.join(' ').replace(/\0/g, '').trim();
      if (Number.isInteger(pid) && cmdline === this.packageName) result.push(pid);
    }
    return result.sort((a, b) => a - b);
  }

  async readCpuTotals() {
    const output = await this.adb.shell("cat /proc/stat | head -n 1", { check: false });
    return parseCpuTotals(output);
  }

  async readProcessTimes(pids) {
    const script = pids.map((pid) => `cat /proc/${pid}/stat 2>/dev/null || true`).join('; ');
    const output = await this.adb.shell(script, { check: false });
    return output.split(/\r?\n/).map(parseProcStatLine).filter(Boolean);
  }

  async readTopCpuPct(pids) {
    const output = await this.adb.shell(`top -b -n 1 -p ${pids.join(' ')}`, { check: false });
    return parseTopCpuPct(output, pids);
  }

  async readRssKb(pids) {
    const script = pids.map((pid) => `cat /proc/${pid}/status 2>/dev/null | grep VmRSS || true`).join('; ');
    const output = await this.adb.shell(script, { check: false });
    let total = 0;
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && /^\d+$/.test(parts[1])) total += Number(parts[1]);
    }
    return total;
  }

  async maybeRefreshPss(force) {
    const now = nowSeconds();
    if (!force && this.pssIntervalSec > 0 && now - this.lastPssAt < this.pssIntervalSec) {
      return {
        pssKb: this.lastPssKb,
        breakdownKb: { ...this.lastBreakdownKb },
        objects: { ...this.lastObjects }
      };
    }
    const output = await this.adb.shell(`dumpsys meminfo ${this.packageName}`, { check: false });
    const parsed = parseMeminfoPss(output);
    if (parsed.totalPssKb !== null) {
      this.lastPssAt = now;
      this.lastPssKb = parsed.totalPssKb;
      this.lastBreakdownKb = parsed.breakdownKb;
      this.lastObjects = parsed.objects;
    } else if (force) {
      this.resetRuntimeCache();
      this.lastPssAt = now;
    }
    return {
      pssKb: this.lastPssKb,
      breakdownKb: { ...this.lastBreakdownKb },
      objects: { ...this.lastObjects }
    };
  }
}
