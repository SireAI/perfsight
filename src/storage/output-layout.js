import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sanitizePackageName } from '../core/format.js';

export function createOutputLayout({ outputDir, packageName, stamp, leakDumpDir = 'captures' }) {
  const packageStem = sanitizePackageName(packageName);
  const sessionDir = path.join(outputDir, 'sessions', packageStem, stamp);
  const capturesRootDir = path.join(outputDir, leakDumpDir);
  const capturesPackageDir = path.join(capturesRootDir, packageStem);
  const simpleperfPackageDir = path.join(outputDir, 'simpleperf', packageStem);
  const logsPackageDir = path.join(outputDir, 'logs', packageStem);
  return {
    packageStem,
    sessionDir,
    sessionCsvPath: path.join(sessionDir, 'samples.csv'),
    sessionMetaPath: path.join(sessionDir, 'session.json'),
    sessionReportPath: path.join(sessionDir, 'report.html'),
    capturesRootDir,
    capturesPackageDir,
    simpleperfPackageDir,
    logsPackageDir
  };
}

export async function resetPackageArtifacts({ outputDir, packageName, leakDumpDir = 'captures' }) {
  const packageStem = sanitizePackageName(packageName);
  const targets = [
    path.join(outputDir, 'sessions', packageStem),
    path.join(outputDir, leakDumpDir, packageStem),
    path.join(outputDir, 'simpleperf', packageStem),
    path.join(outputDir, 'logs', packageStem)
  ];
  await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })));
  await Promise.all([
    pruneEmptyDir(path.join(outputDir, 'sessions')),
    pruneEmptyDir(path.join(outputDir, leakDumpDir)),
    pruneEmptyDir(path.join(outputDir, 'simpleperf')),
    pruneEmptyDir(path.join(outputDir, 'logs'))
  ]);
}

export async function ensureOutputLayout(layout) {
  await Promise.all([
    mkdir(layout.sessionDir, { recursive: true }),
    mkdir(layout.capturesRootDir, { recursive: true }),
    mkdir(layout.simpleperfPackageDir, { recursive: true }),
    mkdir(layout.logsPackageDir, { recursive: true })
  ]);
}

async function pruneEmptyDir(dirPath) {
  try {
    const entries = await readdir(dirPath);
    if (entries.length === 0) {
      await rm(dirPath, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}
