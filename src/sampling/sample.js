import { isoFromSeconds } from '../core/time.js';
import { roundOrNull } from '../core/format.js';

export function buildSample(prev, curr, packageName) {
  const deltaTotal = curr.totalCpu - prev.totalCpu;
  const prevTimes = new Map(prev.processTimes.map((proc) => [proc.pid, proc.utime + proc.stime]));
  const currTimes = new Map(curr.processTimes.map((proc) => [proc.pid, proc.utime + proc.stime]));
  const commonPids = [...currTimes.keys()].filter((pid) => prevTimes.has(pid));
  let appCpuPct = null;
  if (deltaTotal > 0 && commonPids.length) {
    const deltaProc = commonPids.reduce((sum, pid) => sum + currTimes.get(pid) - prevTimes.get(pid), 0);
    appCpuPct = Math.max(0, (100 * deltaProc) / deltaTotal);
  } else if (curr.topCpuPct !== null) {
    appCpuPct = curr.topCpuPct;
  }
  let totalCpuPct = null;
  if (deltaTotal > 0) {
    const deltaIdle = curr.idleCpu - prev.idleCpu;
    totalCpuPct = Math.max(0, Math.min(100, (100 * (deltaTotal - deltaIdle)) / deltaTotal));
  }
  const status = curr.pids.length ? 'running' : 'not-running';
  let note = '';
  if (prev.pids.length && !curr.pids.length) note = 'process exited';
  else if (curr.pids.length && setsDiffer(prev.pids, curr.pids)) note = 'pid changed';
  const activities = curr.meminfoObjects.activities ?? null;
  const viewRootImpl = curr.meminfoObjects.viewrootimpl ?? null;
  const activityGap = activities !== null && viewRootImpl !== null ? activities - viewRootImpl : null;
  const pssBreakdownMb = Object.fromEntries(
    Object.entries(curr.pssBreakdownKb || {}).map(([key, value]) => [key, value / 1024])
  );
  return {
    timestamp: curr.timestamp,
    timestampIso: isoFromSeconds(curr.timestamp),
    package: packageName,
    pidCount: curr.pids.length,
    pids: curr.pids,
    appCpuPct,
    totalCpuPct,
    rssMb: curr.rssKb / 1024,
    pssMb: curr.pssKb === null ? null : curr.pssKb / 1024,
    pssBreakdownMb,
    javaHeapMb: pssBreakdownMb.java_heap ?? null,
    nativeHeapMb: pssBreakdownMb.native_heap ?? null,
    meminfoObjects: { ...curr.meminfoObjects },
    activities,
    viewRootImpl,
    activityGap,
    status,
    cpuSource: curr.cpuSource,
    note,
    leakStatus: 'disabled',
    leakReasons: [],
    leakStructState: 'struct-normal',
    leakWatermarkState: 'watermark-normal',
    dumpHprofPath: '',
    dumpManifestPath: '',
    dumpType: ''
  };
}

export function sampleToJson(sample) {
  return {
    timestamp: roundOrNull(sample.timestamp, 3),
    timestamp_iso: sample.timestampIso,
    package: sample.package,
    pid_count: sample.pidCount,
    pids: sample.pids,
    app_cpu_pct: roundOrNull(sample.appCpuPct),
    total_cpu_pct: roundOrNull(sample.totalCpuPct),
    rss_mb: roundOrNull(sample.rssMb),
    pss_mb: roundOrNull(sample.pssMb),
    pss_breakdown_mb: Object.fromEntries(Object.entries(sample.pssBreakdownMb).map(([key, value]) => [key, roundOrNull(value)])),
    java_heap_mb: roundOrNull(sample.javaHeapMb),
    native_heap_mb: roundOrNull(sample.nativeHeapMb),
    meminfo_objects: sample.meminfoObjects,
    activities: sample.activities,
    view_root_impl: sample.viewRootImpl,
    activity_gap: sample.activityGap,
    status: sample.status,
    cpu_source: sample.cpuSource,
    note: sample.note,
    leak_status: sample.leakStatus,
    leak_reasons: sample.leakReasons,
    leak_struct_state: sample.leakStructState,
    leak_watermark_state: sample.leakWatermarkState,
    dump_hprof_path: sample.dumpHprofPath,
    dump_manifest_path: sample.dumpManifestPath,
    dump_type: sample.dumpType
  };
}

function setsDiffer(left, right) {
  if (left.length !== right.length) return true;
  const rightSet = new Set(right);
  return left.some((value) => !rightSet.has(value));
}
