import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const roots = ['bin', 'src', 'scripts', 'test'];
const files = [];

for (const root of roots) {
  await collectJsFiles(path.resolve(root), files);
}

for (const file of files.sort()) {
  await check(file);
}

async function collectJsFiles(dir, output) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsFiles(fullPath, output);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      output.push(fullPath);
    }
  }
}

function check(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`node --check failed: ${file}`));
    });
  });
}
