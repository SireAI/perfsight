import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AdbError } from '../adb/adb-client.js';
import { sanitizePackageName } from '../core/format.js';
import { timestampStamp } from '../core/time.js';

export async function createSimpleperfCapture({
  adb,
  packageName,
  outputDir,
  logger,
  useRoot = false
}) {
  const command = await resolveDeviceSimpleperfCommand(adb);
  const geckoProfileConverter = await resolveGeckoProfileConverter();
  await logger?.info('simpleperf 运行时已就绪', {
    package: packageName,
    device_command: command,
    export_root_dir: path.join(outputDir, 'simpleperf', sanitizePackageName(packageName)),
    use_root: useRoot,
    gecko_converter_source: geckoProfileConverter?.source || '',
    gecko_converter_script: geckoProfileConverter?.scriptPath || '',
    gecko_converter_python: geckoProfileConverter?.pythonPath || ''
  });
  return new SimpleperfCapture({
    adb,
    packageName,
    outputDir,
    logger: logger || null,
    useRoot,
    command,
    geckoProfileConverter
  });
}

export function buildFirefoxProfilerUrl(profileUrl) {
  return `https://profiler.firefox.com/from-url/${encodeURIComponent(profileUrl)}`;
}

export function getBundledSimpleperfRuntimeDir() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../vendor/simpleperf');
}

export function getBundledGeckoProfileConverterPath() {
  const scriptPath = path.join(getBundledSimpleperfRuntimeDir(), 'gecko_profile_generator.py');
  return existsSync(scriptPath) ? scriptPath : '';
}

export function getBundledSimpleperfHostLibraryPath() {
  const runtimeDir = getBundledSimpleperfRuntimeDir();
  let libraryPath = '';
  if (process.platform === 'darwin') {
    libraryPath = path.join(runtimeDir, 'bin', 'darwin', 'x86_64', 'libsimpleperf_report.dylib');
  } else if (process.platform === 'linux') {
    libraryPath = path.join(runtimeDir, 'bin', 'linux', 'x86_64', 'libsimpleperf_report.so');
  } else if (process.platform === 'win32') {
    libraryPath = path.join(runtimeDir, 'bin', 'windows', 'x86_64', 'libsimpleperf_report.dll');
  }
  return libraryPath && existsSync(libraryPath) ? libraryPath : '';
}

class SimpleperfCapture {
  constructor({ adb, packageName, outputDir, logger, useRoot, command, geckoProfileConverter }) {
    this.adb = adb;
    this.packageName = packageName;
    this.outputDir = outputDir;
    this.logger = logger;
    this.useRoot = useRoot;
    this.command = command;
    this.geckoProfileConverter = geckoProfileConverter || null;
    this.activeSession = null;
  }

  async shell(command, { check = false } = {}) {
    if (this.useRoot) {
      return this.adb.shell(`su -c ${quote(command)}`, { check });
    }
    return this.adb.shell(command, { check });
  }

  async start(sample) {
    if (this.activeSession) {
      throw new AdbError('simpleperf recording already in progress');
    }
    const pid = sample?.pids?.[0];
    if (!pid) throw new AdbError('no pid available for simpleperf recording');
    const stamp = timestampStamp(sample.timestamp);
    const packageStem = sanitizePackageName(this.packageName);
    const fileStem = `${packageStem}_${stamp}_pid${pid}`;
    const sessionDir = path.join(this.outputDir, 'simpleperf', packageStem, `${stamp}_pid${pid}`);
    await mkdir(sessionDir, { recursive: true });
    const remotePerfData = `/data/local/tmp/${fileStem}.perf.data`;
    const localPerfData = path.join(sessionDir, `${fileStem}.perf.data`);
    const geckoProfilePath = path.join(sessionDir, `${fileStem}.gecko-profile.json`);
    await this.logger?.info('准备启动 simpleperf 录制', {
      package: this.packageName,
      pid,
      session_dir: sessionDir,
      local_perf_data_path: localPerfData,
      local_gecko_profile_path: geckoProfilePath
    });
    const startCommand = [
      'nohup',
      quote(this.command),
      'record',
      '-p', String(pid),
      '-g',
      '-o', quote(remotePerfData),
      '</dev/null',
      '>/dev/null',
      '2>&1',
      '&',
      'echo $!'
    ].join(' ');
    const output = (await this.shell(startCommand, { check: false })).trim();
    const devicePid = parseDevicePid(output);
    if (!devicePid) {
      throw new AdbError(`failed to start simpleperf recording${output ? `: ${output}` : ''}`);
    }
    await sleep(300);
    const running = await this.isProcessRunning(devicePid);
    if (!running) {
      throw new AdbError(`simpleperf exited immediately${output ? `: ${output}` : ''}`);
    }
    this.activeSession = {
      devicePid,
      appPid: pid,
      remotePerfData,
      localPerfData,
      geckoProfilePath,
      startedAt: sample.timestamp,
      startedAtIso: sample.timestampIso,
      packageStem
    };
    await this.logger?.info('开始录制 simpleperf CPU profile', {
      package: this.packageName,
      pid,
      device_pid: devicePid,
      output_path: localPerfData,
      remote_output_path: remotePerfData,
      use_root: this.useRoot,
      command: this.command
    });
    return {
      pid,
      devicePid,
      startedAt: sample.timestamp,
      startedAtIso: sample.timestampIso
    };
  }

  currentSession() {
    if (!this.activeSession) return null;
    return { ...this.activeSession };
  }

  async stop() {
    const session = this.activeSession;
    if (!session) {
      throw new AdbError('no simpleperf recording in progress');
    }
    this.activeSession = null;
    const stoppedAt = Date.now() / 1000;
    const stoppedAtIso = new Date(stoppedAt * 1000).toISOString();
    let stopError = '';
    try {
      await this.logger?.info('准备停止 simpleperf 录制', {
        package: this.packageName,
        pid: session.appPid,
        device_pid: session.devicePid,
        remote_output_path: session.remotePerfData,
        local_output_path: session.localPerfData
      });
      await this.shell(`kill -INT ${session.devicePid}`, { check: false });
      const exited = await this.waitForProcessExit(session.devicePid, 15000);
      if (!exited) {
        await this.shell(`kill -TERM ${session.devicePid}`, { check: false });
        if (!(await this.waitForProcessExit(session.devicePid, 5000))) {
          await this.shell(`kill -KILL ${session.devicePid}`, { check: false });
        }
      }
      const remoteSize = await this.waitForRemotePerfData(session.remotePerfData);
      if (remoteSize <= 0) {
        throw new AdbError(`simpleperf produced empty file: ${session.remotePerfData}`);
      }
      await this.logger?.info('simpleperf 录制文件已稳定，开始导出', {
        package: this.packageName,
        pid: session.appPid,
        remote_output_path: session.remotePerfData,
        remote_size: remoteSize
      });
      await this.ensureRemotePerfDataReadable(session.remotePerfData);
      await this.adb.pull(session.remotePerfData, session.localPerfData);
      await this.logger?.info('simpleperf perf.data 已拉取到本地', {
        package: this.packageName,
        pid: session.appPid,
        local_output_path: session.localPerfData
      });
      await this.shell(`rm -f ${quote(session.remotePerfData)}`, { check: false });
      let geckoProfileError = '';
      if (this.geckoProfileConverter) {
        try {
          await this.generateGeckoProfile({
            perfDataPath: session.localPerfData,
            geckoProfilePath: session.geckoProfilePath
          });
        } catch (error) {
          geckoProfileError = String(error?.message || error);
          await this.logger?.warn('simpleperf Gecko profile 转换失败', {
            package: this.packageName,
            pid: session.appPid,
            perf_data_path: session.localPerfData,
            gecko_profile_path: session.geckoProfilePath,
            error: geckoProfileError
          });
        }
      } else {
        geckoProfileError = 'gecko profile converter unavailable';
        await this.logger?.warn('Gecko profile 转换器不可用，将仅保留 perf.data', {
          package: this.packageName,
          pid: session.appPid,
          perf_data_path: session.localPerfData
        });
      }
      const durationSec = Math.max(0.1, Number((stoppedAt - session.startedAt).toFixed(3)));
      await this.logger?.info('simpleperf CPU profile 录制完成', {
        package: this.packageName,
        pid: session.appPid,
        output_path: session.localPerfData,
        gecko_profile_path: geckoProfileError ? '' : session.geckoProfilePath,
        remote_output_path: session.remotePerfData,
        remote_size: remoteSize,
        duration_sec: durationSec
      });
      return {
        pid: session.appPid,
        startedAt: session.startedAt,
        startedAtIso: session.startedAtIso,
        stoppedAt,
        stoppedAtIso,
        perfDataPath: session.localPerfData,
        geckoProfilePath: geckoProfileError ? '' : session.geckoProfilePath,
        geckoProfileError,
        durationSec
      };
    } catch (error) {
      stopError = String(error?.message || error);
      await this.logger?.error('结束 simpleperf CPU profile 失败', {
        package: this.packageName,
        pid: session.appPid,
        device_pid: session.devicePid,
        error: stopError
      });
      throw error;
    } finally {
      if (stopError) {
        await this.shell(`rm -f ${quote(session.remotePerfData)}`, { check: false }).catch(() => {});
      }
    }
  }

  async abort() {
    const session = this.activeSession;
    if (!session) return;
    this.activeSession = null;
    await this.logger?.warn('simpleperf 录制已中止', {
      package: this.packageName,
      pid: session.appPid,
      device_pid: session.devicePid,
      remote_output_path: session.remotePerfData
    });
    await this.shell(`kill -KILL ${session.devicePid}`, { check: false }).catch(() => {});
    await this.shell(`rm -f ${quote(session.remotePerfData)}`, { check: false }).catch(() => {});
  }

  async generateGeckoProfile({ perfDataPath, geckoProfilePath }) {
    const converter = this.geckoProfileConverter;
    if (!converter) {
      throw new Error('gecko profile converter unavailable');
    }
    await this.logger?.info('开始转换 Gecko profile', {
      package: this.packageName,
      perf_data_path: perfDataPath,
      gecko_profile_path: geckoProfilePath,
      converter_script: converter.scriptPath,
      converter_source: converter.source || 'unknown'
    });
    await runProcess(converter.pythonPath, [
      converter.scriptPath,
      '-i',
      perfDataPath
    ], {
      cwd: converter.cwd,
      stdoutFilePath: geckoProfilePath
    });
  }

  async isProcessRunning(devicePid) {
    const output = (await this.shell(`kill -0 ${devicePid} >/dev/null 2>&1; echo $?`, { check: false })).trim();
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) === '0';
  }

  async waitForProcessExit(devicePid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isProcessRunning(devicePid))) {
        return true;
      }
      await sleep(250);
    }
    return !(await this.isProcessRunning(devicePid));
  }

  async remoteFileSize(remotePath) {
    const output = (await this.shell(`wc -c < ${quote(remotePath)} 2>/dev/null`, { check: false })).trim();
    return /^\d+$/.test(output) ? Number(output) : 0;
  }

  async waitForRemotePerfData(remotePath, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let stableHits = 0;
    while (Date.now() < deadline) {
      const size = await this.remoteFileSize(remotePath);
      if (size > 0) {
        if (size === lastSize) stableHits += 1;
        else stableHits = 0;
        if (stableHits >= 2) return size;
      }
      lastSize = size;
      await sleep(500);
    }
    return this.remoteFileSize(remotePath);
  }

  async ensureRemotePerfDataReadable(remotePath) {
    if (!this.useRoot) return;
    await this.shell(`chmod 0644 ${quote(remotePath)}`, { check: false });
  }
}

async function resolveDeviceSimpleperfCommand(adb) {
  const output = (await adb.shell(
    'command -v simpleperf 2>/dev/null || which simpleperf 2>/dev/null || ' +
    '[ -x /system/bin/simpleperf ] && echo /system/bin/simpleperf || ' +
    '[ -x /system/xbin/simpleperf ] && echo /system/xbin/simpleperf',
    { check: false }
  )).trim();
  const command = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  if (!command) {
    throw new AdbError('simpleperf not available on device');
  }
  return command;
}

async function resolveGeckoProfileConverter() {
  const pythonPath = await findFirstAvailableCommand(['python3', 'python']);
  if (!pythonPath) return null;
  const candidates = [
    bundledGeckoConverterCandidate(),
    ...ndkGeckoConverterCandidates()
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = await runProcess(pythonPath, [candidate.scriptPath, '--help'], {
      cwd: candidate.cwd,
      check: false
    });
    if (result.code === 0) {
      return {
        pythonPath,
        scriptPath: candidate.scriptPath,
        cwd: candidate.cwd,
        source: candidate.source
      };
    }
  }
  return null;
}

function bundledGeckoConverterCandidate() {
  const scriptPath = getBundledGeckoProfileConverterPath();
  const hostLibraryPath = getBundledSimpleperfHostLibraryPath();
  if (!scriptPath || !hostLibraryPath) return null;
  return {
    scriptPath,
    cwd: getBundledSimpleperfRuntimeDir(),
    source: 'bundled'
  };
}

function ndkGeckoConverterCandidates() {
  const roots = [
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'ndk') : '',
    process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'ndk') : '',
    path.join(os.homedir(), 'Library/Android/sdk/ndk'),
    path.join(os.homedir(), 'Android/Sdk/ndk'),
    path.join(os.homedir(), 'Android/sdk/ndk')
  ].filter(Boolean);
  const scriptPaths = [];
  for (const root of roots) {
    for (const version of knownNdkVersions(root)) {
      scriptPaths.push(path.join(root, version, 'simpleperf', 'gecko_profile_generator.py'));
    }
  }
  scriptPaths.push(
    path.join(os.homedir(), 'Library/Android/sdk/ndk-bundle/simpleperf/gecko_profile_generator.py'),
    path.join(os.homedir(), 'Android/Sdk/ndk-bundle/simpleperf/gecko_profile_generator.py'),
    path.join(os.homedir(), 'Android/sdk/ndk-bundle/simpleperf/gecko_profile_generator.py')
  );
  return [...new Set(scriptPaths)]
    .filter((scriptPath) => existsSync(scriptPath))
    .map((scriptPath) => ({
      scriptPath,
      cwd: path.dirname(scriptPath),
      source: 'ndk'
    }));
}

function knownNdkVersions(root) {
  try {
    return pathVersionSortDescending(readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name));
  } catch {
    return [];
  }
}

function pathVersionSortDescending(values) {
  return [...values].sort((left, right) => compareVersionString(right, left));
}

function compareVersionString(left, right) {
  const leftParts = String(left).split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = String(right).split(/[^0-9]+/).filter(Boolean).map(Number);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < max; index += 1) {
    const a = leftParts[index] || 0;
    const b = rightParts[index] || 0;
    if (a !== b) return a - b;
  }
  return String(left).localeCompare(String(right));
}

function findFirstAvailableCommand(commands) {
  return new Promise((resolve) => {
    const queue = [...commands];
    const next = () => {
      const command = queue.shift();
      if (!command) {
        resolve('');
        return;
      }
      const child = spawn(command, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      child.once('error', () => next());
      child.once('close', (code) => {
        if (code === 0) {
          resolve(command);
          return;
        }
        next();
      });
    };
    next();
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      try {
        if (options.stdoutFilePath) {
          await writeFile(options.stdoutFilePath, stdout, 'utf8');
        }
        if (options.check === false) {
          resolve({ code, signal, stdout, stderr });
          return;
        }
        if (code === 0) {
          resolve({ code, signal, stdout, stderr });
          return;
        }
        reject(new Error(
          stderr.trim()
          || stdout.trim()
          || `${command} exited with code ${code ?? 'unknown'}${signal ? ` (signal: ${signal})` : ''}`
        ));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseDevicePid(output) {
  const match = String(output || '').match(/(^|\n)\s*(\d+)\s*(?=\n|$)/);
  return match ? Number(match[2]) : 0;
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
