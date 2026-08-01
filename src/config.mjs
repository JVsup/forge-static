import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_DIR = path.join(ROOT, 'snapshot');
export const CACHE_DIR = path.join(SNAPSHOT_DIR, 'cache');
export const DATA_DIR = path.join(SNAPSHOT_DIR, 'data');
export const ASSET_DIR = path.join(SNAPSHOT_DIR, 'assets');
export const DOCS_DIR = path.join(ROOT, 'docs');
export const TEMPLATE_DIR = path.join(ROOT, 'templates');
export const STATIC_DIR = path.join(ROOT, 'static');

export const FORGE_ORIGIN = 'https://forge.sp-tarkov.com';
export const FORGE_STATIC_ORIGIN = 'https://forge-static.sp-tarkov.com';
export const API_ORIGIN = `${FORGE_ORIGIN}/api/v0`;
export const SPT_FILTER = '>=4.0.0';
export const API_INTERVAL_MS = Number(process.env.FORGE_API_INTERVAL_MS || 500);
export const SNAPSHOT_DATE = process.env.SNAPSHOT_DATE || new Date().toISOString();
export const MAX_DOCS_BYTES = 900 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export const FORGE_HOSTS = new Set([
  'forge.sp-tarkov.com',
  'forge-static.sp-tarkov.com',
]);

