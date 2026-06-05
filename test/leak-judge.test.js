import test from 'node:test';
import assert from 'node:assert/strict';
import { LeakJudge } from '../src/leak/leak-judge.js';

function makeConfig() {
  return {
    enabled: true,
    warmupSec: 0,
    dumpThresholdMb: 256,
    javaHeapMaxMb: 100,
    javaHeapWatchRatio: 0.7,
    javaHeapDumpRatio: 0.8,
    structGapSuspect: 2,
    structGapHigh: 3,
    structSuspectHits: 2,
    structHighHits: 6,
    structHighGapHits: 3,
    structRecoverHits: 3,
    cooldownSec: 900,
    maxDumpsPerPid: 2,
    maxDumpsPerSession: 3,
    dumpDir: 'captures'
  };
}

function makeSample({ timestamp = Date.now() / 1000, javaHeapMb = 0, pssMb = 0, gap = 0 } = {}) {
  return {
    timestamp,
    status: 'running',
    pids: [123],
    javaHeapMb,
    pssMb,
    activityGap: gap
  };
}

test('watermark high confidence requests dump without trend windows', () => {
  const judge = new LeakJudge(makeConfig());
  assert.equal(judge.evaluate(makeSample({ javaHeapMb: 69, pssMb: 120 })).watermarkState, 'watermark-normal');

  const suspected = judge.evaluate(makeSample({ javaHeapMb: 70, pssMb: 120 }));
  assert.equal(suspected.watermarkState, 'watermark-suspected');
  assert.equal(suspected.dumpRequested, false);

  const high = judge.evaluate(makeSample({ javaHeapMb: 80, pssMb: 120 }));
  assert.equal(high.watermarkState, 'watermark-high-confidence');
  assert.equal(high.dumpRequested, true);
});

test('structure high confidence requires total pss threshold to dump', () => {
  const judge = new LeakJudge(makeConfig());
  let decision = null;
  for (let i = 0; i < 6; i += 1) {
    decision = judge.evaluate(makeSample({ timestamp: Date.now() / 1000 + i, javaHeapMb: 20, pssMb: 200, gap: 2 }));
  }
  assert.equal(decision.structState, 'struct-high-confidence');
  assert.equal(decision.dumpRequested, false);

  const pssHigh = judge.evaluate(makeSample({ timestamp: Date.now() / 1000 + 7, javaHeapMb: 20, pssMb: 256, gap: 2 }));
  assert.equal(pssHigh.dumpRequested, true);
});
