export class LeakJudge {
  constructor(config) {
    this.config = config;
    this.startedAt = Date.now() / 1000;
    this.currentPid = null;
    this.structSuspectStreak = 0;
    this.structGapHighStreak = 0;
    this.structRecoverStreak = 0;
    this.lastDumpAt = 0;
    this.dumpCountsByPid = new Map();
    this.dumpCountSession = 0;
  }

  evaluate(sample) {
    if (!this.config.enabled) {
      return decision('disabled');
    }
    const pid = sample.pids[0] ?? null;
    if (pid !== this.currentPid) {
      this.resetForPid(pid);
    }
    if (sample.status !== 'running' || pid === null) {
      return decision('not-running');
    }
    if (sample.timestamp - this.startedAt < this.config.warmupSec) {
      return decision('warmup');
    }

    const [structState, structReasons] = this.evaluateStructure(sample);
    const [watermarkState, watermarkReasons] = this.evaluateWatermark(sample);
    const reasons = [...structReasons, ...watermarkReasons];
    const leakStatus = this.classify(sample, structState, watermarkState);
    const dumpRequested = this.shouldDump(sample, structState, watermarkState);
    return { leakStatus, reasons, structState, watermarkState, dumpRequested };
  }

  markDumped(sample) {
    const pid = sample.pids[0];
    if (!pid) return;
    this.lastDumpAt = sample.timestamp;
    this.dumpCountSession += 1;
    this.dumpCountsByPid.set(pid, (this.dumpCountsByPid.get(pid) || 0) + 1);
  }

  resetForPid(pid) {
    this.currentPid = pid;
    this.structSuspectStreak = 0;
    this.structGapHighStreak = 0;
    this.structRecoverStreak = 0;
    this.startedAt = Date.now() / 1000;
  }

  evaluateStructure(sample) {
    const gap = sample.activityGap;
    const reasons = [];
    if (gap === null || gap === undefined) return ['struct-normal', reasons];
    if (gap <= 1) {
      this.structRecoverStreak += 1;
      if (this.structRecoverStreak >= this.config.structRecoverHits) {
        this.structSuspectStreak = 0;
        this.structGapHighStreak = 0;
      }
      return ['struct-normal', reasons];
    }
    this.structRecoverStreak = 0;
    if (gap >= this.config.structGapSuspect) this.structSuspectStreak += 1;
    else this.structSuspectStreak = 0;
    if (gap >= this.config.structGapHigh) this.structGapHighStreak += 1;
    else this.structGapHighStreak = 0;

    reasons.push(`activity_gap=${gap}`);
    if (this.structSuspectStreak >= this.config.structHighHits || this.structGapHighStreak >= this.config.structHighGapHits) {
      reasons.push('struct-high-confidence');
      return ['struct-high-confidence', reasons];
    }
    if (this.structSuspectStreak >= this.config.structSuspectHits) {
      reasons.push('struct-suspected');
      return ['struct-suspected', reasons];
    }
    return ['struct-normal', reasons];
  }

  evaluateWatermark(sample) {
    const reasons = [];
    if (sample.javaHeapMb === null || !this.config.javaHeapMaxMb || this.config.javaHeapMaxMb <= 0) {
      return ['watermark-normal', reasons];
    }
    const ratio = sample.javaHeapMb / Math.max(this.config.javaHeapMaxMb, 1e-6);
    reasons.push(`java_heap_ratio=${ratio.toFixed(3)}`);
    reasons.push(`java_heap_max_mb=${this.config.javaHeapMaxMb.toFixed(1)}`);
    if (ratio >= this.config.javaHeapDumpRatio) {
      reasons.push('watermark-high-confidence');
      return ['watermark-high-confidence', reasons];
    }
    if (ratio >= this.config.javaHeapWatchRatio) {
      reasons.push('watermark-suspected');
      return ['watermark-suspected', reasons];
    }
    return ['watermark-normal', reasons];
  }

  classify(sample, structState, watermarkState) {
    if (this.inCooldown(sample.timestamp)) return 'cooldown';
    if (structState === 'struct-high-confidence') return 'leak-suspected';
    if (structState === 'struct-suspected') return 'watching';
    if (watermarkState === 'watermark-high-confidence') return 'leak-suspected';
    if (watermarkState === 'watermark-suspected') return 'watching';
    if (
      sample.pssMb !== null &&
      sample.pssMb >= this.config.dumpThresholdMb &&
      (sample.javaHeapMb === null || sample.javaHeapMb < this.config.javaHeapMaxMb * this.config.javaHeapWatchRatio) &&
      structState === 'struct-normal'
    ) {
      return 'non-java-memory-pressure';
    }
    return 'not-leaking';
  }

  shouldDump(sample, structState, watermarkState) {
    if (this.inCooldown(sample.timestamp)) return false;
    if (this.dumpCountSession >= this.config.maxDumpsPerSession) return false;
    const pid = sample.pids[0];
    if (!pid) return false;
    if ((this.dumpCountsByPid.get(pid) || 0) >= this.config.maxDumpsPerPid) return false;
    const pssAtDump = sample.pssMb !== null && sample.pssMb >= this.config.dumpThresholdMb;
    if (watermarkState === 'watermark-high-confidence') return true;
    if (structState === 'struct-suspected' && watermarkState === 'watermark-suspected') return true;
    if (structState === 'struct-high-confidence' && pssAtDump) return true;
    return false;
  }

  inCooldown(timestamp) {
    return this.lastDumpAt > 0 && timestamp - this.lastDumpAt < this.config.cooldownSec;
  }
}

export function buildLeakConfig(options, javaHeapMaxMb) {
  const watchRatio = clamp(Number(options['leak-java-watch-ratio']), 0, 1);
  const dumpRatio = Math.max(watchRatio, clamp(Number(options['leak-java-dump-ratio']), 0, 1));
  return {
    enabled: Boolean(options['enable-leak-capture']),
    warmupSec: 10,
    dumpThresholdMb: Number(options['leak-dump-threshold-mb']),
    javaHeapMaxMb,
    javaHeapWatchRatio: watchRatio,
    javaHeapDumpRatio: dumpRatio,
    structGapSuspect: 2,
    structGapHigh: 3,
    structSuspectHits: 2,
    structHighHits: 6,
    structHighGapHits: 3,
    structRecoverHits: 3,
    cooldownSec: Number(options['leak-cooldown-sec']),
    maxDumpsPerPid: Number(options['leak-max-dumps-per-pid']),
    maxDumpsPerSession: Number(options['leak-max-dumps-per-session']),
    dumpDir: String(options['leak-dump-dir'])
  };
}

function decision(leakStatus) {
  return {
    leakStatus,
    reasons: [],
    structState: 'struct-normal',
    watermarkState: 'watermark-normal',
    dumpRequested: false
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
