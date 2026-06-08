import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { createOutputLayout, resetPackageArtifacts } from '../src/storage/output-layout.js';

test('createOutputLayout organizes artifacts by package and session', () => {
  const layout = createOutputLayout({
    outputDir: '/tmp/perfsight-data',
    packageName: 'com.example.app',
    stamp: '20260608_123456',
    leakDumpDir: 'captures'
  });

  assert.equal(layout.sessionDir, '/tmp/perfsight-data/sessions/com_example_app/20260608_123456');
  assert.equal(layout.sessionCsvPath, '/tmp/perfsight-data/sessions/com_example_app/20260608_123456/samples.csv');
  assert.equal(layout.sessionMetaPath, '/tmp/perfsight-data/sessions/com_example_app/20260608_123456/session.json');
  assert.equal(layout.sessionReportPath, '/tmp/perfsight-data/sessions/com_example_app/20260608_123456/report.html');
  assert.equal(layout.capturesPackageDir, '/tmp/perfsight-data/captures/com_example_app');
  assert.equal(layout.simpleperfPackageDir, '/tmp/perfsight-data/simpleperf/com_example_app');
  assert.equal(layout.logsPackageDir, '/tmp/perfsight-data/logs/com_example_app');
});

test('resetPackageArtifacts clears only managed package artifacts', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'perfsight-output-'));
  await mkdir(path.join(outputDir, 'sessions', 'com_example_app', 'run1'), { recursive: true });
  await mkdir(path.join(outputDir, 'captures', 'com_example_app', 'dump1'), { recursive: true });
  await mkdir(path.join(outputDir, 'simpleperf', 'com_example_app', 'record1'), { recursive: true });
  await mkdir(path.join(outputDir, 'logs', 'com_example_app'), { recursive: true });
  await mkdir(path.join(outputDir, 'sessions', 'com_other_app', 'run2'), { recursive: true });
  await writeFile(path.join(outputDir, 'sessions', 'com_example_app', 'run1', 'samples.csv'), 'x');
  await writeFile(path.join(outputDir, 'captures', 'com_example_app', 'dump1', 'heap.hprof'), 'x');
  await writeFile(path.join(outputDir, 'simpleperf', 'com_example_app', 'record1', 'perf.data'), 'x');
  await writeFile(path.join(outputDir, 'logs', 'com_example_app', '20260608_120000.log'), 'x');
  await writeFile(path.join(outputDir, 'sessions', 'com_other_app', 'run2', 'samples.csv'), 'y');

  await resetPackageArtifacts({
    outputDir,
    packageName: 'com.example.app',
    leakDumpDir: 'captures'
  });

  assert.equal(existsSync(path.join(outputDir, 'sessions', 'com_example_app')), false);
  assert.equal(existsSync(path.join(outputDir, 'captures', 'com_example_app')), false);
  assert.equal(existsSync(path.join(outputDir, 'simpleperf', 'com_example_app')), false);
  assert.equal(existsSync(path.join(outputDir, 'logs', 'com_example_app')), false);
  assert.equal(existsSync(path.join(outputDir, 'sessions', 'com_other_app', 'run2', 'samples.csv')), true);
});
