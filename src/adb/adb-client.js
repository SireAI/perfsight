import { spawnFile } from './process.js';

export class AdbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdbError';
  }
}

export class AdbClient {
  constructor({ serial } = {}) {
    this.serial = serial || '';
  }

  baseArgs() {
    return this.serial ? ['-s', this.serial] : [];
  }

  async adb(args, { check = true } = {}) {
    const result = await spawnFile('adb', [...this.baseArgs(), ...args]);
    if (!check && result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim();
      if (AdbClient.isDeviceUnavailableError(message)) {
        throw new AdbError(message || `adb ${args.join(' ')}`);
      }
    }
    if (check && result.code !== 0) {
      throw new AdbError(result.stderr.trim() || result.stdout.trim() || `adb ${args.join(' ')}`);
    }
    return result.stdout;
  }

  async shell(command, { check = true } = {}) {
    return this.adb(['shell', command], { check });
  }

  async pull(remotePath, localPath) {
    const result = await spawnFile('adb', [...this.baseArgs(), 'pull', remotePath, localPath]);
    if (result.code !== 0) {
      throw new AdbError(result.stderr.trim() || result.stdout.trim() || `adb pull ${remotePath}`);
    }
  }

  async ensureDevice() {
    const serial = await this.adb(['get-serialno'], { check: false });
    const text = serial.trim();
    if (!text || text === 'unknown' || text === '<unknown>') {
      throw new AdbError('no adb device available');
    }
  }

  async getProp(name) {
    return (await this.shell(`getprop ${name}`, { check: false })).trim();
  }

  async deviceInfo() {
    const [manufacturer, model, device, release, sdk, serial, cpuPresent, cpuPossible, cpuFreqSummary] = await Promise.all([
      this.getProp('ro.product.manufacturer'),
      this.getProp('ro.product.model'),
      this.getProp('ro.product.device'),
      this.getProp('ro.build.version.release'),
      this.getProp('ro.build.version.sdk'),
      this.adb(['get-serialno'], { check: false }).then((value) => value.trim()),
      this.shell('cat /sys/devices/system/cpu/present 2>/dev/null', { check: false }).then((value) => value.trim()),
      this.shell('cat /sys/devices/system/cpu/possible 2>/dev/null', { check: false }).then((value) => value.trim()),
      this.cpuFrequencySummary()
    ]);
    const modelText = [manufacturer, model].filter(Boolean).join(' ') || device || '-';
    const android = [release ? `Android ${release}` : '', sdk ? `API ${sdk}` : ''].filter(Boolean).join(' / ') || '-';
    const cpuCores = parseCpuCoreCount(cpuPresent) || parseCpuCoreCount(cpuPossible) || 0;
    return {
      model: modelText,
      device: device || '-',
      android,
      serial: serial || this.serial || 'default',
      cpu_cores: cpuCores || null,
      cpu_frequency: cpuFreqSummary || '-'
    };
  }

  async cpuFrequencySummary() {
    const output = await this.shell(
      'for p in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_max_freq; do ' +
      '[ -f "$p" ] && echo "$(cat "$p")"; ' +
      'done',
      { check: false }
    );
    return summarizeCpuFrequencies(output);
  }

  async javaHeapGrowthLimitMb() {
    const raw = await this.getProp('dalvik.vm.heapgrowthlimit');
    const match = raw.match(/^(\d+(?:\.\d+)?)([kKmMgG]?)$/);
    if (!match) return 0;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'g') return value * 1024;
    if (unit === 'k') return value / 1024;
    return value;
  }

  async packageCapabilities(packageName) {
    const [packageInfo, suPath] = await Promise.all([
      this.shell(`dumpsys package ${packageName}`, { check: false }),
      this.shell('command -v su 2>/dev/null || which su 2>/dev/null', { check: false })
    ]);
    const rooted = Boolean(suPath.trim());
    const debuggable = /\bdebuggable=true\b|\bDEBUGGABLE\b/i.test(packageInfo);
    const profileable = debuggable || /\bprofileable=true\b|\bprofileableByShell=true\b/i.test(packageInfo);
    let dumpReason = 'package is not debuggable and device is not rooted';
    if (debuggable) dumpReason = 'package is debuggable';
    else if (rooted) dumpReason = 'root device available';
    return { debuggable, profileable, rooted, dumpReason };
  }

  static isDeviceUnavailableError(error) {
    const message = String(error?.message || error).toLowerCase();
    return [
      'adb device unavailable',
      'no adb device available',
      'no devices/emulators found',
      'device offline',
      'device not found',
      'more than one device/emulator',
      'cannot connect to daemon',
      'closed'
    ].some((marker) => message.includes(marker));
  }
}

export function parseCpuCoreCount(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  let total = 0;
  for (const segment of text.split(',')) {
    const part = segment.trim();
    if (!part) continue;
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        total += (end - start + 1);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      total += 1;
    }
  }
  return total;
}

export function summarizeCpuFrequencies(value) {
  const values = String(value || '')
    .split(/\r?\n/)
    .map((line) => Number(String(line).trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  if (!values.length) return '';
  const groups = new Map();
  for (const item of values) {
    groups.set(item, (groups.get(item) || 0) + 1);
  }
  return [...groups.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([freq, count]) => `${count} x ${formatCpuFrequency(freq)}`)
    .join(' + ');
}

function formatCpuFrequency(freqKhz) {
  const mhz = Number(freqKhz) / 1000;
  if (mhz >= 1000) return `${(mhz / 1000).toFixed(2)} GHz`;
  return `${Math.round(mhz)} MHz`;
}
