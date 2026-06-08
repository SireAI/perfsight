import { parseArgs, printHelp } from './args.js';
import { run } from '../app/run.js';
import { AdbClient } from '../adb/adb-client.js';
import {
  checkForSelfUpdate,
  formatSelfUpdateMessage,
  formatUpgradeCommand,
  installSelfUpdate,
  readCliPackageMeta
} from './self-update.js';

async function maybeNotifySelfUpdate(command, options) {
  const meta = await readCliPackageMeta();
  const result = await checkForSelfUpdate({
    command,
    currentVersion: meta.version,
    packageName: meta.packageName,
    packageRoot: meta.packageRoot,
    channel: options.channel,
    force: Boolean(options['check-update'])
  });
  if (result.updateAvailable) {
    const message = formatSelfUpdateMessage({
      ...result,
      packageName: meta.packageName
    });
    if (message) {
      process.stderr.write(`${message}\n`);
    }
  }
  return { meta, result };
}

async function handleVersionCommand(options) {
  const meta = await readCliPackageMeta();
  const result = await checkForSelfUpdate({
    command: 'version',
    currentVersion: meta.version,
    packageName: meta.packageName,
    packageRoot: meta.packageRoot,
    channel: options.channel,
    force: Boolean(options['check-update'])
  });
  process.stdout.write(`perfsight ${meta.version}\n`);
  process.stdout.write(`package: ${meta.packageName}\n`);
  process.stdout.write(`channel: ${result.channel}\n`);
  process.stdout.write(`install source: ${result.installSource}\n`);
  if (result.latestVersion) {
    process.stdout.write(`latest: ${result.latestVersion}\n`);
  }
  process.stdout.write(`update available: ${result.updateAvailable ? 'yes' : 'no'}\n`);
  if (result.updateAvailable) {
    process.stdout.write(`upgrade: ${formatUpgradeCommand(meta.packageName, result.channel)}\n`);
  }
}

async function handleUpgradeCommand(options) {
  const meta = await readCliPackageMeta();
  const result = await installSelfUpdate({
    currentVersion: meta.version,
    packageName: meta.packageName,
    packageRoot: meta.packageRoot,
    channel: options.channel,
    force: Boolean(options.force)
  });
  process.stdout.write(`perfsight ${meta.version}\n`);
  process.stdout.write(`install source: ${result.installSource}\n`);
  process.stdout.write(`channel: ${result.channel}\n`);
  if (result.latestVersion) {
    process.stdout.write(`target: ${result.latestVersion}\n`);
  }

  if (result.success && result.reason === 'already_latest') {
    process.stdout.write('already latest\n');
    return;
  }

  if (result.success) {
    process.stdout.write('upgrade succeeded\n');
    return;
  }

  if (result.reason === 'unsupported_installation') {
    process.stdout.write('automatic upgrade is only supported for global npm installs\n');
    process.stdout.write(`manual upgrade: ${formatUpgradeCommand(meta.packageName, result.channel)}\n`);
    process.exitCode = 2;
    return;
  }

  if (result.reason === 'version_lookup_failed' || result.reason === 'package_not_published') {
    process.stdout.write(`${result.message || 'unable to resolve a published version from npm registry'}\n`);
    process.exitCode = 2;
    return;
  }

  process.stdout.write('upgrade failed\n');
  if (result.state?.lastError) {
    process.stdout.write(`${result.state.lastError}\n`);
  }
  process.exitCode = 1;
}

export function formatCliError(error) {
  if (AdbClient.isDeviceUnavailableError(error)) {
    return [
      'No adb device detected.',
      '',
      'Please check the following and try again:',
      '1. Connect or reconnect your phone.',
      '2. Make sure USB debugging is enabled.',
      '3. Run `adb devices` and confirm the device status is `device`.',
      '4. Re-run the perfsight command.'
    ].join('\n');
  }
  if (error && error.code === 'EADDRINUSE') {
    const host = error.address || '127.0.0.1';
    const port = error.port || 'unknown';
    return [
      `Web UI port is already in use: ${host}:${port}`,
      '',
      'Please try one of the following:',
      '1. Stop the other process using this port.',
      '2. Re-run with another port, for example: `--port 8766`.'
    ].join('\n');
  }
  if (process.env.PERFSIGHT_DEBUG === '1') {
    return error && error.stack ? error.stack : String(error);
  }
  return error instanceof Error ? error.message : String(error);
}

export async function main(argv) {
  const { command, packageName, options, helpTopic } = parseArgs(argv);
  if (options.help) {
    const topic = helpTopic || (command === 'text' || command === 'web' ? command : '');
    printHelp(process.stdout, topic);
    return;
  }
  if (command === 'version') {
    await handleVersionCommand(options);
    return;
  }
  if (command === 'upgrade') {
    await handleUpgradeCommand(options);
    return;
  }
  if (!packageName) {
    printHelp(process.stderr);
    process.exitCode = 2;
    return;
  }
  await maybeNotifySelfUpdate(command, options);
  await run({ packageName, options });
}
