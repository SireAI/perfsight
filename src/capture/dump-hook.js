import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60000;

export function createDumpHookRunner({ command, logger, runtimeLogPath }) {
  const normalized = String(command || '').trim();
  if (!normalized) return null;
  return new DumpHookRunner({
    command: normalized,
    logger: logger || null,
    runtimeLogPath: runtimeLogPath || ''
  });
}

export function buildDumpHookArgs(payload) {
  const args = [];
  pushArg(args, '--event', payload.event);
  pushArg(args, '--package', payload.packageName);
  pushArg(args, '--pid', payload.pid);
  pushArg(args, '--dump-type', payload.dumpType);
  pushArg(args, '--timestamp', payload.timestampIso);
  pushArg(args, '--status', payload.status);
  pushArg(args, '--manifest', payload.manifestPath);
  pushArg(args, '--hprof', payload.hprofPath);
  pushArg(args, '--runtime-log', payload.runtimeLogPath);
  if (Array.isArray(payload.reasons)) {
    payload.reasons.forEach((reason) => pushArg(args, '--reason', reason));
  }
  if (payload.errorMessage) {
    pushArg(args, '--error', payload.errorMessage);
  }
  return args;
}

class DumpHookRunner {
  constructor({ command, logger, runtimeLogPath }) {
    this.command = command;
    this.logger = logger;
    this.runtimeLogPath = runtimeLogPath;
  }

  async run(payload) {
    const args = buildDumpHookArgs({
      ...payload,
      runtimeLogPath: payload.runtimeLogPath || this.runtimeLogPath
    });
    const shellCommand = [this.command, ...args.map(quoteShellArg)].join(' ');
    await this.logger?.info('开始执行 dump hook', {
      hook_command: this.command,
      event: payload.event,
      dump_type: payload.dumpType,
      package: payload.packageName
    });
    const result = await runShell(shellCommand);
    if (result.code === 0) {
      await this.logger?.info('dump hook 执行成功', {
        hook_command: this.command,
        event: payload.event,
        stdout: trimOutput(result.stdout),
        stderr: trimOutput(result.stderr)
      });
      return result;
    }
    const message = result.signal
      ? `dump hook exited with signal ${result.signal}`
      : `dump hook exited with code ${result.code}`;
    await this.logger?.error('dump hook 执行失败', {
      hook_command: this.command,
      event: payload.event,
      code: result.code,
      signal: result.signal,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr)
    });
    throw new Error(message);
  }
}

function pushArg(target, key, value) {
  if (value === null || value === undefined || value === '') return;
  target.push(key, String(value));
}

function trimOutput(value, maxLength = 500) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runShell(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const shell = resolveShell();
  const args = shellArgs(shell, command);
  return new Promise((resolve, reject) => {
    const child = spawn(shell.command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function resolveShell() {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', type: 'cmd' };
  }
  return { command: process.env.SHELL || '/bin/sh', type: 'posix' };
}

function shellArgs(shell, command) {
  if (shell.type === 'cmd') {
    return ['/d', '/s', '/c', command];
  }
  return ['-lc', command];
}
