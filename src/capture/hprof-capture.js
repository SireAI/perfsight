import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { timestampStamp } from '../core/time.js';
import { sanitizePackageName, jsonLine } from '../core/format.js';
import { AdbError } from '../adb/adb-client.js';

export class HprofCapture {
  constructor({ adb, packageName, captureDir, useRoot = false }) {
    this.adb = adb;
    this.packageName = packageName;
    this.captureDir = captureDir;
    this.useRoot = useRoot;
  }

  async shell(command, { check = false } = {}) {
    if (this.useRoot) {
      return this.adb.shell(`su -c ${quote(command)}`, { check });
    }
    return this.adb.shell(command, { check });
  }

  async capture(sample, reasons, dumpType = 'leak') {
    const pid = sample.pids[0];
    if (!pid) throw new AdbError('no pid available for hprof dump');
    const stamp = timestampStamp(sample.timestamp);
    const packageStem = sanitizePackageName(this.packageName);
    const fileStem = `${packageStem}_${stamp}_pid${pid}`;
    const sessionDir = path.join(this.captureDir, packageStem, `${stamp}_pid${pid}`);
    await mkdir(sessionDir, { recursive: true });
    const remotePath = `/data/local/tmp/${fileStem}.hprof`;
    const localHprof = path.join(sessionDir, `${fileStem}.hprof`);
    const manifestPath = path.join(sessionDir, `${fileStem}.json`);
    let dumpCommand = `am dumpheap -g ${pid} ${quote(remotePath)}`;
    if (this.useRoot) dumpCommand = `${dumpCommand} && chmod 0644 ${quote(remotePath)}`;
    const dumpOutput = (await this.shell(dumpCommand, { check: false })).trim();
    const remoteSize = await this.waitForRemoteHprof(remotePath);
    if (remoteSize <= 0) throw new AdbError(`hprof dump produced empty file: ${remotePath}`);
    await this.adb.pull(remotePath, localHprof);
    await this.shell(`rm -f ${quote(remotePath)}`, { check: false });
    const primaryRule = primaryDumpTriggerRule(sample, reasons, dumpType);
    const manifest = {
      package: this.packageName,
      pid,
      timestamp: sample.timestampIso,
      dump_type: dumpType,
      primary_dump_trigger_rule: primaryRule,
      primary_dump_trigger_label: triggerLabel(primaryRule),
      reasons,
      leak_rule_types: leakRuleTypes(sample, reasons, dumpType),
      leak_struct_state: sample.leakStructState,
      leak_watermark_state: sample.leakWatermarkState,
      java_heap_mb: sample.javaHeapMb,
      native_heap_mb: sample.nativeHeapMb,
      total_pss_mb: sample.pssMb,
      activities: sample.activities,
      view_root_impl: sample.viewRootImpl,
      activity_gap: sample.activityGap,
      dump_output: dumpOutput,
      remote_hprof_size: remoteSize,
      local_hprof_path: localHprof
    };
    await writeFile(manifestPath, jsonLine(manifest), 'utf8');
    return { hprofPath: localHprof, manifestPath };
  }

  async remoteFileSize(remotePath) {
    const output = (await this.shell(`wc -c < ${quote(remotePath)} 2>/dev/null`, { check: false })).trim();
    return /^\d+$/.test(output) ? Number(output) : 0;
  }

  async waitForRemoteHprof(remotePath, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let stableHits = 0;
    while (Date.now() < deadline) {
      const size = await this.remoteFileSize(remotePath);
      if (size > 0) {
        if (size === lastSize) stableHits += 1;
        else stableHits = 0;
        if (stableHits >= 2) return size;
      }
      lastSize = size;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return this.remoteFileSize(remotePath);
  }
}

function leakRuleTypes(sample, reasons, dumpType) {
  if (dumpType !== 'leak') return [];
  const result = [];
  if (sample.leakStructState !== 'struct-normal' || reasons.some((reason) => reason.startsWith('struct-') || reason.startsWith('activity_gap='))) {
    result.push('struct');
  }
  if (sample.leakWatermarkState !== 'watermark-normal' || reasons.some((reason) => reason.startsWith('watermark-') || reason.startsWith('java_heap_ratio='))) {
    result.push('watermark');
  }
  return result;
}

function primaryDumpTriggerRule(sample, reasons, dumpType) {
  if (dumpType === 'manual') return 'manual';
  if (sample.leakWatermarkState === 'watermark-high-confidence') return 'watermark';
  if (sample.leakStructState === 'struct-high-confidence') return 'struct';
  return leakRuleTypes(sample, reasons, dumpType)[0] || '';
}

function triggerLabel(rule) {
  return {
    manual: 'manual-trigger',
    struct: 'struct-rule',
    watermark: 'watermark-rule'
  }[rule] || '';
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
