import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildFirefoxProfilerUrl,
  getBundledGeckoProfileConverterPath,
  getBundledSimpleperfHostLibraryPath,
  getBundledSimpleperfRuntimeDir
} from '../src/capture/simpleperf-capture.js';
import { WebState } from '../src/web/web-state.js';

function createSample() {
  return {
    timestamp: 1780649895.707,
    timestampIso: '2026-06-05T08:58:15.707Z',
    package: 'com.example.app',
    pidCount: 1,
    pids: [23028],
    appCpuPct: 12.3,
    totalCpuPct: 44.5,
    rssMb: 321,
    pssMb: 256,
    pssBreakdownMb: {
      java_heap: 128,
      native_heap: 64
    },
    javaHeapMb: 128,
    nativeHeapMb: 64,
    meminfoObjects: {},
    activities: 3,
    viewRootImpl: 2,
    activityGap: 1,
    status: 'running',
    cpuSource: 'procfs',
    note: '',
    leakStatus: 'disabled',
    leakReasons: [],
    leakStructState: 'struct-normal',
    leakWatermarkState: 'watermark-normal',
    dumpHprofPath: '',
    dumpManifestPath: '',
    dumpType: ''
  };
}

test('buildFirefoxProfilerUrl encodes the local profile URL', () => {
  const url = buildFirefoxProfilerUrl('http://127.0.0.1:8877/downloads/cpu-profile/1/perf-data');
  assert.equal(
    url,
    'https://profiler.firefox.com/from-url/http%3A%2F%2F127.0.0.1%3A8877%2Fdownloads%2Fcpu-profile%2F1%2Fperf-data'
  );
});

test('bundled Gecko converter runtime is available in the package tree', () => {
  const runtimeDir = getBundledSimpleperfRuntimeDir();
  const converterPath = getBundledGeckoProfileConverterPath();
  const hostLibraryPath = getBundledSimpleperfHostLibraryPath();
  assert.match(runtimeDir, /src\/vendor\/simpleperf$/);
  assert.equal(
    converterPath,
    path.join(runtimeDir, 'gecko_profile_generator.py')
  );
  if (process.platform === 'darwin') {
    assert.equal(
      hostLibraryPath,
      path.join(runtimeDir, 'bin', 'darwin', 'x86_64', 'libsimpleperf_report.dylib')
    );
  } else {
    assert.equal(hostLibraryPath, '');
  }
});

test('WebState records CPU profile events with Firefox Profiler links', () => {
  const sample = createSample();
  const state = new WebState({
    packageName: 'com.example.app',
    intervalSec: 0.5,
    csvPath: '/tmp/sample.csv',
    metaPath: '/tmp/sample.json',
    sampleStore: {
      snapshot() {
        return [sample];
      },
      latest() {
        return sample;
      },
      clear() {}
    },
    capture: null,
    dumpReason: 'leak capture disabled',
    capabilities: {
      debuggable: true,
      profileable: true,
      rooted: false
    },
    deviceInfo: {},
    appMaxJavaHeapMb: null,
    simpleperfCapture: {},
    webBaseUrl: 'http://127.0.0.1:8877'
  });

  const event = state.recordCpuProfile(sample, {
    perfDataPath: '/tmp/profile.perf.data',
    geckoProfilePath: '/tmp/profile.gecko-profile.json',
    geckoProfileError: '',
    durationSec: 10
  });

  assert.equal(event.perf_data_download_url, '/downloads/cpu-profile/1/perf-data');
  assert.equal(event.gecko_profile_download_url, '/downloads/cpu-profile/1/gecko-profile');
  assert.equal(
    event.firefox_profiler_url,
    'https://profiler.firefox.com/from-url/http%3A%2F%2F127.0.0.1%3A8877%2Fdownloads%2Fcpu-profile%2F1%2Fgecko-profile'
  );
  assert.deepEqual(state.findCpuProfile(1), event);
});

test('WebState start/stop CPU recording stores active range metadata', async () => {
  const sample = createSample();
  let started = false;
  const state = new WebState({
    packageName: 'com.example.app',
    intervalSec: 0.5,
    csvPath: '/tmp/sample.csv',
    metaPath: '/tmp/sample.json',
    sampleStore: {
      snapshot() {
        return [sample];
      },
      latest() {
        return sample;
      },
      clear() {}
    },
    capture: null,
    dumpReason: 'leak capture disabled',
    capabilities: {
      debuggable: false,
      profileable: false,
      rooted: true
    },
    deviceInfo: {},
    appMaxJavaHeapMb: null,
    simpleperfCapture: {
      async start() {
        started = true;
        return {
          pid: 23028,
          devicePid: 9999,
          startedAt: sample.timestamp,
          startedAtIso: sample.timestampIso
        };
      },
      async stop() {
        return {
          pid: 23028,
          startedAt: sample.timestamp,
          startedAtIso: sample.timestampIso,
          stoppedAt: sample.timestamp + 12,
          stoppedAtIso: '2026-06-05T08:58:27.707Z',
          perfDataPath: '/tmp/profile.perf.data',
          geckoProfilePath: '/tmp/profile.gecko-profile.json',
          geckoProfileError: '',
          durationSec: 12
        };
      }
    },
    webBaseUrl: 'http://127.0.0.1:8877'
  });

  await state.startCpuProfile();
  assert.equal(started, true);
  assert.equal(state.cpuProfileInProgress, true);
  assert.equal(state.payload().cpu_profile_in_progress_started_at, sample.timestampIso);

  const event = await state.stopCpuProfile();

  assert.equal(event.duration_sec, 12);
  assert.equal(state.cpuProfileInProgress, false);
  assert.equal(state.cpuProfileInProgressPid, null);
  assert.equal(state.payload().last_cpu_profile_event.duration_sec, 12);
  assert.equal(state.payload().last_cpu_profile_event.started_at_iso, sample.timestampIso);
  assert.equal(state.payload().last_cpu_profile_event.ended_at_iso, '2026-06-05T08:58:27.707Z');
});

test('WebState enables CPU recording on rooted devices without profileable flag', () => {
  const state = new WebState({
    packageName: 'com.example.app',
    intervalSec: 0.5,
    csvPath: '/tmp/sample.csv',
    metaPath: '/tmp/sample.json',
    sampleStore: {
      snapshot() {
        return [];
      },
      latest() {
        return null;
      },
      clear() {}
    },
    capture: null,
    dumpReason: 'leak capture disabled',
    capabilities: {
      debuggable: false,
      profileable: false,
      rooted: true
    },
    deviceInfo: {},
    appMaxJavaHeapMb: null,
    simpleperfCapture: {},
    webBaseUrl: 'http://127.0.0.1:8877'
  });

  const payload = state.payload();
  assert.equal(payload.manual_cpu_profile_enabled, true);
  assert.equal(payload.manual_cpu_profile_reason, '');
});

test('WebState resets CPU profile history on device change', () => {
  const sample = createSample();
  const state = new WebState({
    packageName: 'com.example.app',
    intervalSec: 0.5,
    csvPath: '/tmp/sample.csv',
    metaPath: '/tmp/sample.json',
    sampleStore: {
      snapshot() {
        return [sample];
      },
      latest() {
        return sample;
      },
      clear() {}
    },
    capture: null,
    dumpReason: 'leak capture disabled',
    capabilities: {
      debuggable: true,
      profileable: true,
      rooted: false
    },
    deviceInfo: {},
    appMaxJavaHeapMb: null,
    simpleperfCapture: {},
    webBaseUrl: 'http://127.0.0.1:8877'
  });

  state.recordCpuProfile(sample, {
    perfDataPath: '/tmp/profile.perf.data',
    geckoProfilePath: '/tmp/profile.gecko-profile.json',
    geckoProfileError: '',
    durationSec: 10
  });
  state.cpuProfileInProgress = true;
  state.cpuProfileInProgressMessage = 'simpleperf recording in progress';

  state.resetForDeviceChange('device switched');

  assert.equal(state.findCpuProfile(1), null);
  assert.equal(state.cpuProfileInProgress, false);
  assert.equal(state.cpuProfileInProgressMessage, '');
});
