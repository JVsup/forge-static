import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJson(target, value) {
  await ensureDir(path.dirname(target));
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, target);
}

export async function writeText(target, value) {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function listFiles(directory) {
  const output = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else output.push(absolute);
    }
  }
  if (await pathExists(directory)) await visit(directory);
  return output;
}

export async function directorySize(directory) {
  let total = 0;
  for (const file of await listFiles(directory)) total += (await fs.stat(file)).size;
  return total;
}

export function posixPath(value) {
  return value.split(path.sep).join('/');
}

