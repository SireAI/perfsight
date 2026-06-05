export { AdbClient, AdbError } from './adb/adb-client.js';
export { PackageCollector } from './sampling/package-collector.js';
export { buildSample } from './sampling/sample.js';
export { LeakJudge } from './leak/leak-judge.js';
export { HprofCapture } from './capture/hprof-capture.js';
export { run } from './app/run.js';
export {
  checkForSelfUpdate,
  compareVersions,
  formatSelfUpdateMessage,
  installSelfUpdate,
  readCliPackageMeta
} from './cli/self-update.js';
