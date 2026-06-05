import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, printHelp } from '../src/cli/args.js';

test('parseArgs recognizes help command and topic', () => {
  const parsed = parseArgs(['help', 'web']);
  assert.equal(parsed.command, 'help');
  assert.equal(parsed.helpTopic, 'web');
  assert.equal(parsed.options.help, true);
});

test('parseArgs recognizes text subcommand', () => {
  const parsed = parseArgs(['text', 'com.example.app']);
  assert.equal(parsed.command, 'text');
  assert.equal(parsed.helpTopic, '');
  assert.equal(parsed.packageName, 'com.example.app');
  assert.equal(parsed.options.mode, 'text');
});

test('parseArgs recognizes web subcommand', () => {
  const parsed = parseArgs(['web', 'com.example.app']);
  assert.equal(parsed.command, 'web');
  assert.equal(parsed.packageName, 'com.example.app');
  assert.equal(parsed.options.mode, 'web');
});

test('parseArgs no longer accepts package name without subcommand', () => {
  const parsed = parseArgs(['com.example.app']);
  assert.equal(parsed.command, '');
  assert.equal(parsed.packageName, '');
  assert.equal(parsed.options.mode, undefined);
});

test('printHelp shows top-level help topics', () => {
  let text = '';
  printHelp({ write(chunk) { text += chunk; } }, '');
  assert.match(text, /perfsight help \[text\|web\|leak-capture\]/);
  assert.match(text, /Usage: perfsight text <package> \[options\]/);
  assert.match(text, /1\. text mode/);
  assert.match(text, /2\. web mode/);
});

test('printHelp shows text topic help', () => {
  let text = '';
  printHelp({ write(chunk) { text += chunk; } }, 'text');
  assert.match(text, /Usage: perfsight text <package> \[options\]/);
  assert.match(text, /Text mode prints live samples/);
  assert.doesNotMatch(text, /--no-export-report/);
});

test('printHelp shows web topic help', () => {
  let text = '';
  printHelp({ write(chunk) { text += chunk; } }, 'web');
  assert.match(text, /Usage: perfsight web <package> \[options\]/);
  assert.match(text, /--enable-leak-capture/);
  assert.doesNotMatch(text, /--no-open-browser/);
});

test('printHelp shows leak topic help', () => {
  let text = '';
  printHelp({ write(chunk) { text += chunk; } }, 'leak-capture');
  assert.match(text, /structure rule/);
  assert.match(text, /watermark rule/);
  assert.doesNotMatch(text, /leak-warmup-sec/);
  assert.doesNotMatch(text, /leak-struct-gap-suspect/);
  assert.doesNotMatch(text, /leak-struct-gap-high/);
});
