import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeminfoPss } from '../src/parsers/meminfo.js';

test('parse dumpsys meminfo App Summary and Objects', () => {
  const output = `
App Summary
                       Pss(KB)
              Java Heap:    102400
            Native Heap:     51200
                 Graphics:      2560
            Private Other:      1024
                  System:      2048

Objects
              Views:       10         ViewRootImpl:        1
         AppContexts:        4           Activities:        3

TOTAL PSS:   160000
`;
  const parsed = parseMeminfoPss(output);
  assert.equal(parsed.totalPssKb, 160000);
  assert.equal(parsed.breakdownKb.java_heap, 102400);
  assert.equal(parsed.breakdownKb.native_heap, 51200);
  assert.equal(parsed.objects.activities, 3);
  assert.equal(parsed.objects.viewrootimpl, 1);
});
