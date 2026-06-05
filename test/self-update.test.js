import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions,
  formatSelfUpdateMessage,
  formatUpgradeCommand
} from '../src/cli/self-update.js';

test('compareVersions handles stable semver ordering', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0') > 0, true);
  assert.equal(compareVersions('0.1.0', '0.1.1') < 0, true);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('compareVersions handles snapshot prerelease ordering', () => {
  assert.equal(compareVersions('0.1.1-snapshot.20260605.2', '0.1.1-snapshot.20260605.1') > 0, true);
  assert.equal(compareVersions('0.1.1', '0.1.1-snapshot.20260605.2') > 0, true);
});

test('formatUpgradeCommand returns latest and snapshot commands', () => {
  assert.equal(formatUpgradeCommand('@perfsight/cli', 'latest'), 'npm install -g @perfsight/cli@latest');
  assert.equal(formatUpgradeCommand('@perfsight/cli', 'snapshot'), 'npm install -g @perfsight/cli@snapshot');
});

test('formatSelfUpdateMessage renders upgrade guidance', () => {
  const message = formatSelfUpdateMessage({
    currentVersion: '0.1.0',
    latestVersion: '0.1.1',
    updateAvailable: true,
    packageName: '@perfsight/cli',
    channel: 'latest'
  });
  assert.match(message, /Update available: 0.1.0 -> 0.1.1/);
  assert.match(message, /npm install -g @perfsight\/cli@latest/);
});
