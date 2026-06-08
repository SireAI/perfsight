import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const roots = [
  path.resolve('src'),
  path.resolve('tools')
];

await Promise.all(roots.map(cleanTree));

async function cleanTree(rootPath) {
  let entries = [];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        await rm(entryPath, { recursive: true, force: true });
        return;
      }
      await cleanTree(entryPath);
      return;
    }
    if (entry.isFile() && entry.name.endsWith('.pyc')) {
      await rm(entryPath, { force: true });
    }
  }));
}
