import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_JSON_PATH = resolve(PACKAGE_ROOT, 'package.json');
const SELF_UPDATE_STATE_PATH = join(homedir(), '.perfsight', 'self-update.json');
const DEFAULT_CHECK_INTERVAL_HOURS = 12;
const NPM_VIEW_TIMEOUT_MS = 1500;

export function compareVersions(left, right) {
  const [leftCore, leftPrerelease] = String(left || '').split('-', 2);
  const [rightCore, rightPrerelease] = String(right || '').split('-', 2);
  const leftParts = leftCore.split('.').map((value) => Number.parseInt(value, 10) || 0);
  const rightParts = rightCore.split('.').map((value) => Number.parseInt(value, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }

  const leftHasPrerelease = Boolean(leftPrerelease);
  const rightHasPrerelease = Boolean(rightPrerelease);
  if (leftHasPrerelease === rightHasPrerelease) {
    if (!leftHasPrerelease) {
      return 0;
    }
    const leftSegments = leftPrerelease.split('.');
    const rightSegments = rightPrerelease.split('.');
    const prereleaseLength = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < prereleaseLength; index += 1) {
      const leftSegment = leftSegments[index];
      const rightSegment = rightSegments[index];
      if (leftSegment === rightSegment) {
        continue;
      }
      if (leftSegment === undefined) {
        return -1;
      }
      if (rightSegment === undefined) {
        return 1;
      }
      const leftNumber = /^\d+$/.test(leftSegment) ? Number.parseInt(leftSegment, 10) : undefined;
      const rightNumber = /^\d+$/.test(rightSegment) ? Number.parseInt(rightSegment, 10) : undefined;
      if (typeof leftNumber === 'number' && typeof rightNumber === 'number') {
        if (leftNumber !== rightNumber) {
          return leftNumber - rightNumber;
        }
        continue;
      }
      if (typeof leftNumber === 'number') {
        return -1;
      }
      if (typeof rightNumber === 'number') {
        return 1;
      }
      return leftSegment.localeCompare(rightSegment);
    }
    return 0;
  }

  return leftHasPrerelease ? -1 : 1;
}

export async function readCliPackageMeta() {
  const raw = await readFile(PACKAGE_JSON_PATH, 'utf8');
  const packageJson = JSON.parse(raw);
  return {
    packageName: String(packageJson.name || '').trim(),
    version: String(packageJson.version || '').trim(),
    packageRoot: PACKAGE_ROOT
  };
}

function normalizeChannel(value) {
  return value === 'snapshot' ? 'snapshot' : 'latest';
}

function classifyLookupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('404') || normalized.includes('not found')) {
    return {
      reason: 'package_not_published',
      userMessage: 'package is not published on the selected npm channel yet',
      detail: message
    };
  }
  return {
    reason: 'version_lookup_failed',
    userMessage: message,
    detail: message
  };
}

function inferChannelFromVersion(version) {
  return String(version || '').includes('-snapshot.') ? 'snapshot' : 'latest';
}

export async function readSelfUpdateState(statePath = SELF_UPDATE_STATE_PATH) {
  try {
    const raw = await readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function writeSelfUpdateState(state, statePath = SELF_UPDATE_STATE_PATH) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function detectInstallSource(packageRoot, packageName) {
  const normalizedRoot = String(packageRoot || '');
  const packageSegments = String(packageName || '').split('/').filter(Boolean);

  if (normalizedRoot.includes(`${join('.npm', '_npx')}`) || normalizedRoot.includes(`${join('_npx', '')}`)) {
    return 'npx';
  }
  if (packageSegments.length > 0 && normalizedRoot.includes(join('node_modules', ...packageSegments))) {
    return 'npm_global';
  }
  try {
    await access(join(normalizedRoot, '.git'));
    return 'source_checkout';
  } catch {
    return 'unknown';
  }
}

function shouldCheckForUpdate({ state, currentVersion, channel, force }) {
  if (force) {
    return true;
  }
  if (!state?.lastCheckedAt) {
    return true;
  }
  if (state.currentVersion && state.currentVersion !== currentVersion) {
    return true;
  }
  if (state.channel && state.channel !== channel) {
    return true;
  }
  const lastCheckedAt = Date.parse(state.lastCheckedAt);
  if (!Number.isFinite(lastCheckedAt)) {
    return true;
  }
  return (Date.now() - lastCheckedAt) >= (DEFAULT_CHECK_INTERVAL_HOURS * 60 * 60 * 1000);
}

async function queryPublishedVersion(packageName, channel) {
  const npmArgs = channel === 'snapshot'
    ? ['view', packageName, 'dist-tags.snapshot', '--json']
    : ['view', packageName, 'version', '--json'];
  const result = await execFileAsync('npm', npmArgs, {
    encoding: 'utf8',
    timeout: NPM_VIEW_TIMEOUT_MS,
    maxBuffer: 256 * 1024
  });
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    throw new Error('npm returned an empty version response.');
  }

  const parsed = JSON.parse(stdout);
  if (typeof parsed === 'string' && parsed.trim()) {
    return parsed.trim();
  }
  if (Array.isArray(parsed)) {
    const latest = parsed.filter((item) => typeof item === 'string' && item.trim()).at(-1);
    if (latest) {
      return latest.trim();
    }
  }
  throw new Error(`Unable to parse npm package version for ${channel} channel.`);
}

export async function checkForSelfUpdate(input) {
  const statePath = input.statePath || SELF_UPDATE_STATE_PATH;
  const previousState = await readSelfUpdateState(statePath);
  const channel = normalizeChannel(input.channel || inferChannelFromVersion(input.currentVersion));
  const installSource = await detectInstallSource(input.packageRoot, input.packageName);

  if (!shouldCheckForUpdate({
    state: previousState,
    currentVersion: input.currentVersion,
    channel,
    force: input.force
  })) {
    return {
      checked: false,
      currentVersion: input.currentVersion,
      installSource,
      channel,
      updateAvailable: false,
      state: {
        ...previousState,
        currentVersion: input.currentVersion,
        installSource,
        channel
      },
      reason: 'cached'
    };
  }

  try {
    const latestVersion = await queryPublishedVersion(input.packageName, channel);
    const updateAvailable = compareVersions(latestVersion, input.currentVersion) > 0;
    const state = {
      ...previousState,
      currentVersion: input.currentVersion,
      latestVersion,
      lastCheckedAt: new Date().toISOString(),
      lastCheckStatus: updateAvailable ? 'update_available' : 'up_to_date',
      installSource,
      channel
    };
    delete state.lastError;
    await writeSelfUpdateState(state, statePath);
    return {
      checked: true,
      currentVersion: input.currentVersion,
      latestVersion,
      installSource,
      channel,
      updateAvailable,
      state
    };
  } catch (error) {
    const state = {
      ...previousState,
      currentVersion: input.currentVersion,
      lastCheckedAt: new Date().toISOString(),
      lastCheckStatus: 'check_failed',
      lastError: error instanceof Error ? error.message : String(error),
      installSource,
      channel
    };
    await writeSelfUpdateState(state, statePath);
    return {
      checked: true,
      currentVersion: input.currentVersion,
      installSource,
      channel,
      updateAvailable: false,
      state,
      reason: 'check_failed'
    };
  }
}

function buildUpgradeSpecifier(channel, targetVersion) {
  if (targetVersion?.trim()) {
    return targetVersion.trim();
  }
  return channel === 'snapshot' ? 'snapshot' : 'latest';
}

async function runGlobalNpmInstall(packageName, specifier) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await new Promise((resolve, reject) => {
    const child = spawn(npmCommand, ['install', '-g', `${packageName}@${specifier}`], {
      stdio: 'inherit',
      env: process.env
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm install exited with code ${code ?? 'unknown'}${signal ? ` (signal: ${signal})` : ''}.`));
    });
  });
}

export async function installSelfUpdate(input) {
  const statePath = input.statePath || SELF_UPDATE_STATE_PATH;
  const previousState = await readSelfUpdateState(statePath);
  const channel = normalizeChannel(input.channel || inferChannelFromVersion(input.currentVersion));
  const installSource = await detectInstallSource(input.packageRoot, input.packageName);
  let latestVersion = input.targetVersion;
  try {
    latestVersion = latestVersion || await queryPublishedVersion(input.packageName, channel);
  } catch (error) {
    const failure = classifyLookupFailure(error);
    const state = {
      ...previousState,
      currentVersion: input.currentVersion,
      lastCheckedAt: new Date().toISOString(),
      lastUpgradeAttemptAt: new Date().toISOString(),
      lastCheckStatus: 'check_failed',
      lastError: failure.detail,
      installSource,
      channel
    };
    await writeSelfUpdateState(state, statePath);
    return {
      attempted: false,
      currentVersion: input.currentVersion,
      installSource,
      channel,
      success: false,
      state,
      reason: failure.reason,
      message: failure.userMessage
    };
  }
  const updateAvailable = compareVersions(latestVersion, input.currentVersion) > 0;

  if (installSource !== 'npm_global') {
    const state = {
      ...previousState,
      currentVersion: input.currentVersion,
      latestVersion,
      lastUpgradeAttemptAt: new Date().toISOString(),
      lastCheckStatus: 'upgrade_unsupported',
      lastError: 'Automatic upgrade is only supported for npm global installations.',
      installSource,
      channel
    };
    await writeSelfUpdateState(state, statePath);
    return {
      attempted: false,
      currentVersion: input.currentVersion,
      latestVersion,
      installSource,
      channel,
      success: false,
      state,
      reason: 'unsupported_installation'
    };
  }

  if (!updateAvailable && !input.force) {
    const state = {
      ...previousState,
      currentVersion: input.currentVersion,
      latestVersion,
      lastCheckedAt: new Date().toISOString(),
      lastCheckStatus: 'up_to_date',
      installSource,
      channel
    };
    delete state.lastError;
    await writeSelfUpdateState(state, statePath);
    return {
      attempted: false,
      currentVersion: input.currentVersion,
      latestVersion,
      installSource,
      channel,
      success: true,
      state,
      reason: 'already_latest'
    };
  }

  try {
    await runGlobalNpmInstall(input.packageName, buildUpgradeSpecifier(channel, input.targetVersion));
    const state = {
      ...previousState,
      currentVersion: latestVersion,
      latestVersion,
      lastCheckedAt: new Date().toISOString(),
      lastUpgradeAttemptAt: new Date().toISOString(),
      lastCheckStatus: 'upgrade_succeeded',
      installSource,
      channel
    };
    delete state.lastError;
    await writeSelfUpdateState(state, statePath);
    return {
      attempted: true,
      currentVersion: input.currentVersion,
      latestVersion,
      installSource,
      channel,
      success: true,
      state
    };
  } catch (error) {
    const state = {
      ...previousState,
      currentVersion: input.currentVersion,
      latestVersion,
      lastUpgradeAttemptAt: new Date().toISOString(),
      lastCheckStatus: 'upgrade_failed',
      lastError: error instanceof Error ? error.message : String(error),
      installSource,
      channel
    };
    await writeSelfUpdateState(state, statePath);
    return {
      attempted: true,
      currentVersion: input.currentVersion,
      latestVersion,
      installSource,
      channel,
      success: false,
      state,
      reason: 'upgrade_failed'
    };
  }
}

export function formatUpgradeCommand(packageName, channel = 'latest') {
  return channel === 'snapshot'
    ? `npm install -g ${packageName}@snapshot`
    : `npm install -g ${packageName}@latest`;
}

export function formatSelfUpdateMessage(result) {
  if (!result?.updateAvailable || !result.latestVersion) {
    return '';
  }
  return [
    `[perfsight] Update available: ${result.currentVersion} -> ${result.latestVersion}`,
    `[perfsight] Upgrade: ${formatUpgradeCommand(result.packageName || '@sireai/perfsight', result.channel)}`
  ].join('\n');
}
