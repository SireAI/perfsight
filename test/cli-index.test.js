import test from 'node:test';
import assert from 'node:assert/strict';

import { AdbError } from '../src/adb/adb-client.js';
import { formatCliError } from '../src/cli/index.js';

test('formatCliError shows concise adb recovery guidance', () => {
  const text = formatCliError(new AdbError('adb device unavailable: please connect or reconnect a phone, then retry.'));
  assert.match(text, /No adb device detected\./);
  assert.match(text, /USB debugging/);
  assert.match(text, /adb devices/);
  assert.doesNotMatch(text, /AdbError:/);
});

test('formatCliError keeps generic errors concise by default', () => {
  const text = formatCliError(new Error('something went wrong'));
  assert.equal(text, 'something went wrong');
});

test('formatCliError shows concise guidance for occupied web port', () => {
  const error = new Error('listen EADDRINUSE: address already in use 127.0.0.1:8765');
  error.code = 'EADDRINUSE';
  error.address = '127.0.0.1';
  error.port = 8765;
  const text = formatCliError(error);
  assert.match(text, /Web UI port is already in use: 127\.0\.0\.1:8765/);
  assert.match(text, /--port 8766/);
  assert.doesNotMatch(text, /node:events/);
});
