import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sanitizePackageName } from '../core/format.js';
import { timestampStamp } from '../core/time.js';

const RETENTION_DAYS = 7;

export async function createRuntimeLogger({ outputDir, packageName }) {
  const logsDir = path.join(outputDir, 'logs');
  const packageLogsDir = path.join(logsDir, sanitizePackageName(packageName));
  await mkdir(packageLogsDir, { recursive: true });
  await pruneExpiredLogs(logsDir);
  const filePath = path.join(
    packageLogsDir,
    `${timestampStamp()}.log`
  );
  const logger = new RuntimeLogger(filePath);
  await logger.info('日志系统已启动', {
    package: packageName,
    retention_days: RETENTION_DAYS
  });
  return logger;
}

class RuntimeLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this.pending = Promise.resolve();
  }

  info(message, details = {}) {
    return this.write('INFO', message, details);
  }

  warn(message, details = {}) {
    return this.write('WARN', message, details);
  }

  error(message, details = {}) {
    return this.write('ERROR', message, details);
  }

  write(level, message, details = {}) {
    const line = formatLine(level, message, details);
    this.pending = this.pending
      .then(() => appendFile(this.filePath, line, 'utf8'))
      .catch(() => {});
    return this.pending;
  }
}

function formatLine(level, message, details) {
  const timestamp = new Date().toISOString();
  const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  return `[${timestamp}] [${level}] ${message}${suffix}\n`;
}

async function pruneExpiredLogs(logsDir) {
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await pruneExpiredLogsInDir(logsDir, cutoffMs);
}

async function pruneExpiredLogsInDir(dirPath, cutoffMs) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await pruneExpiredLogsInDir(entryPath, cutoffMs);
      const rest = await readdir(entryPath).catch(() => []);
      if (rest.length === 0) {
        await rm(entryPath, { recursive: true, force: true });
      }
      return;
    }
    if (!entry.isFile() || !entry.name.endsWith('.log')) return;
    const stamp = extractTimestamp(entry.name);
    if (!stamp || stamp >= cutoffMs) return;
    await rm(entryPath, { force: true });
  }));
}

function extractTimestamp(filename) {
  const match = filename.match(/(\d{8}_\d{6})\.log$/);
  if (!match) return null;
  const raw = match[1];
  const text = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}`;
  const value = Date.parse(text);
  return Number.isFinite(value) ? value : null;
}
