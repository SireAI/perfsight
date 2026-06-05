import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCpuCoreCount, summarizeCpuFrequencies } from '../src/adb/adb-client.js';

test('parseCpuCoreCount supports cpu range syntax', () => {
  assert.equal(parseCpuCoreCount('0-7'), 8);
  assert.equal(parseCpuCoreCount('0-3,5,7-8'), 7);
  assert.equal(parseCpuCoreCount(''), 0);
});

test('summarizeCpuFrequencies groups identical cpu max frequencies', () => {
  assert.equal(
    summarizeCpuFrequencies('2000000\n2000000\n2000000\n2800000\n2800000\n'),
    '3 x 2.00 GHz + 2 x 2.80 GHz'
  );
  assert.equal(
    summarizeCpuFrequencies('768000\n768000\n'),
    '2 x 768 MHz'
  );
  assert.equal(summarizeCpuFrequencies(''), '');
});
