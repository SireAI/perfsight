import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonLine } from '../core/format.js';

export async function writeSessionMeta(metaPath, payload) {
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, jsonLine(payload), 'utf8');
}
