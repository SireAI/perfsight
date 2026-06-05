import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { formatNumber } from '../core/format.js';

const HEADER = [
  'timestamp_iso',
  'timestamp_epoch',
  'package',
  'pid_count',
  'pids',
  'app_cpu_pct',
  'total_cpu_pct',
  'pss_mb',
  'pss_breakdown_json',
  'java_heap_mb',
  'native_heap_mb',
  'activities',
  'view_root_impl',
  'activity_gap',
  'status',
  'cpu_source',
  'leak_status',
  'leak_reasons',
  'leak_struct_state',
  'leak_watermark_state',
  'dump_hprof_path',
  'dump_manifest_path',
  'dump_type',
  'note'
];

export class SampleWriter {
  constructor(fileHandle) {
    this.fileHandle = fileHandle;
  }

  static async open(csvPath) {
    await mkdir(path.dirname(csvPath), { recursive: true });
    const handle = await open(csvPath, 'a+');
    const stat = await handle.stat();
    const writer = new SampleWriter(handle);
    if (stat.size === 0) {
      await writer.writeRow(HEADER);
    }
    return writer;
  }

  async write(sample) {
    await this.writeRow([
      sample.timestampIso,
      sample.timestamp.toFixed(3),
      sample.package,
      sample.pidCount,
      sample.pids.join(' '),
      formatNumber(sample.appCpuPct),
      formatNumber(sample.totalCpuPct),
      formatNumber(sample.pssMb),
      JSON.stringify(roundBreakdown(sample.pssBreakdownMb)),
      formatNumber(sample.javaHeapMb),
      formatNumber(sample.nativeHeapMb),
      sample.activities ?? '',
      sample.viewRootImpl ?? '',
      sample.activityGap ?? '',
      sample.status,
      sample.cpuSource,
      sample.leakStatus,
      JSON.stringify(sample.leakReasons),
      sample.leakStructState,
      sample.leakWatermarkState,
      sample.dumpHprofPath,
      sample.dumpManifestPath,
      sample.dumpType,
      sample.note
    ]);
  }

  async writeRow(values) {
    await this.fileHandle.write(`${values.map(csvCell).join(',')}\n`);
  }

  async close() {
    await this.fileHandle.close();
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function roundBreakdown(breakdown) {
  return Object.fromEntries(Object.entries(breakdown || {}).map(([key, value]) => [key, Math.round(value * 100) / 100]));
}
