import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDumpHookArgs } from '../src/capture/dump-hook.js';

test('buildDumpHookArgs serializes dump completion payload', () => {
  const args = buildDumpHookArgs({
    event: 'dump_completed',
    packageName: 'com.example.app',
    pid: 1234,
    dumpType: 'manual',
    timestampIso: '2026-06-05T07:00:00.000Z',
    status: 'completed',
    manifestPath: '/tmp/sample.json',
    hprofPath: '/tmp/sample.hprof',
    runtimeLogPath: '/tmp/runtime.log',
    reasons: ['manual-trigger', 'debuggable'],
    errorMessage: ''
  });

  assert.deepEqual(args, [
    '--event', 'dump_completed',
    '--package', 'com.example.app',
    '--pid', '1234',
    '--dump-type', 'manual',
    '--timestamp', '2026-06-05T07:00:00.000Z',
    '--status', 'completed',
    '--manifest', '/tmp/sample.json',
    '--hprof', '/tmp/sample.hprof',
    '--runtime-log', '/tmp/runtime.log',
    '--reason', 'manual-trigger',
    '--reason', 'debuggable'
  ]);
});

test('buildDumpHookArgs includes failure error message', () => {
  const args = buildDumpHookArgs({
    event: 'dump_failed',
    packageName: 'com.example.app',
    pid: 1234,
    dumpType: 'leak',
    timestampIso: '2026-06-05T07:00:00.000Z',
    status: 'failed',
    reasons: ['watermark-high-confidence'],
    errorMessage: 'dump failed'
  });

  assert.equal(args.includes('--error'), true);
  assert.equal(args.at(-1), 'dump failed');
});
