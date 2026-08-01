import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import {
  DATA_DIR, DOCS_DIR, FORGE_HOSTS, MAX_DOCS_BYTES, MAX_FILE_BYTES, SNAPSHOT_DIR,
} from './config.mjs';
import { extractForgeReferences } from './lib/content.mjs';
import { directorySize, listFiles, pathExists, posixPath, readJson } from './lib/fs.mjs';
import { outputPath } from './lib/render.mjs';

const errors = [];
const warnings = [];
const metrics = {
  htmlPages: 0, mods: 0, addons: 0, versions: 0, images: 0,
  brokenLinks: 0, forgeAttributes: 0, missingAlt: 0,
  externalDownloads: 0, downloadFallbacks: 0,
};

function fail(code, file, detail) {
  errors.push({ code, file: posixPath(path.relative(DOCS_DIR, file)), detail });
}

async function loadRecords(type) {
  const directory = path.join(DATA_DIR, type === 'mod' ? 'mods' : 'addons');
  if (!await pathExists(directory)) return [];
  const values = [];
  for (const name of await fs.readdir(directory)) if (name.endsWith('.json')) values.push(await readJson(path.join(directory, name)));
  return values;
}

function localTarget(sourceFile, value) {
  if (!value || /^(#|mailto:|tel:|data:|blob:|javascript:)/i.test(value)) return null;
  try {
    const parsed = new URL(value, 'https://archive.invalid/base/');
    if (parsed.origin !== 'https://archive.invalid') return null;
  } catch { return null; }
  const clean = decodeURIComponent(value.split('#')[0].split('?')[0]);
  if (!clean) return null;
  if (clean.startsWith('/')) return { absolute: true, path: path.join(DOCS_DIR, clean) };
  const target = path.resolve(path.dirname(sourceFile), clean);
  return { absolute: false, path: clean.endsWith('/') ? path.join(target, 'index.html') : target };
}

function containsForgeUrl(value) {
  if (!value) return false;
  try { return FORGE_HOSTS.has(new URL(value, 'https://archive.invalid').hostname.toLowerCase()); }
  catch { return /(?:forge|forge-static)\.sp-tarkov\.com/i.test(value); }
}

const [mods, addons, state, manifest] = await Promise.all([
  loadRecords('mod'), loadRecords('addon'),
  readJson(path.join(SNAPSHOT_DIR, 'capture-state.json'), {}),
  readJson(path.join(SNAPSHOT_DIR, 'manifest.json'), {}),
]);
metrics.mods = mods.length;
metrics.addons = addons.length;
metrics.versions = [...mods, ...addons].reduce((sum, record) => sum + (record.versions?.length || 0), 0);
metrics.externalDownloads = [...mods, ...addons].flatMap((record) => record.versions || []).filter((version) => version.download?.type === 'external').length;
metrics.downloadFallbacks = [...mods, ...addons].flatMap((record) => record.versions || []).filter((version) => version.download?.type === 'fallback').length;

if (!mods.length) errors.push({ code: 'NO_MODS', file: '', detail: 'No captured mods found' });
if (state.modQueue?.length || state.addonQueue?.length) errors.push({ code: 'OPEN_GRAPH', file: 'snapshot/capture-state.json', detail: `${state.modQueue?.length || 0} mods and ${state.addonQueue?.length || 0} addons remain queued` });
if (manifest.seedModCount && manifest.seedModCount !== state.seedCount) errors.push({ code: 'SEED_MISMATCH', file: 'snapshot/manifest.json', detail: 'Seed count differs from capture state' });

const recordKeys = new Set([...mods, ...addons].map((record) => `${record.type}:${Number(record.id)}`));
for (const record of [...mods, ...addons]) {
  const output = path.join(DOCS_DIR, ...outputPath(record).split('/'));
  if (!await pathExists(output)) fail('MISSING_PAGE', output, `${record.type}:${record.id}`);
  const richValues = [record.description, record.custom_ai_disclosure, ...(record.versions || []).map((version) => version.description)];
  for (const ref of extractForgeReferences(richValues)) {
    if (!recordKeys.has(`${ref.type}:${ref.id}`)) fail('UNCLOSED_GRAPH', output, `${ref.type}:${ref.id}`);
  }
  for (const version of record.versions || []) {
    if (!['external', 'fallback'].includes(version.download?.type)) fail('MISSING_DOWNLOAD_DECISION', output, `Version ${version.version}`);
    if (version.download?.type === 'external' && containsForgeUrl(version.download.url)) fail('FORGE_DOWNLOAD', output, version.download.url);
  }
}

const files = await listFiles(DOCS_DIR);
const htmlFiles = files.filter((file) => path.extname(file).toLowerCase() === '.html');
metrics.htmlPages = htmlFiles.length;
for (const file of files) {
  const stat = await fs.stat(file);
  if (stat.size >= MAX_FILE_BYTES) fail('FILE_TOO_LARGE', file, `${stat.size} bytes`);
}

for (const file of htmlFiles) {
  const html = await fs.readFile(file, 'utf8');
  const $ = cheerio.load(html);
  const attributes = ['href', 'src', 'srcset', 'action', 'formaction'];
  for (const attribute of attributes) {
    $(`[${attribute}]`).each((_, element) => {
      const value = $(element).attr(attribute);
      if (containsForgeUrl(value)) {
        metrics.forgeAttributes += 1;
        fail('ACTIVE_FORGE_URL', file, `${attribute}=${value}`);
      }
      for (const candidate of attribute === 'srcset' ? String(value).split(',').map((part) => part.trim().split(/\s+/)[0]) : [value]) {
        const target = localTarget(file, candidate);
        if (!target) continue;
        if (target.absolute) fail('ROOT_ABSOLUTE_URL', file, candidate);
        else if (!pathExistsSync(target.path)) {
          metrics.brokenLinks += 1;
          fail('BROKEN_LOCAL_LINK', file, candidate);
        }
      }
    });
  }
  $('img').each((_, image) => {
    metrics.images += 1;
    if ($(image).attr('alt') === undefined) {
      metrics.missingAlt += 1;
      fail('MISSING_ALT', file, $(image).attr('src'));
    }
  });
  $('[role="tab"]').each((_, tab) => {
    const label = $(tab).text().trim().toLowerCase();
    if (label.includes('comment') || label.includes('file verification')) fail('FORBIDDEN_TAB', file, label);
  });
  if (posixPath(path.relative(DOCS_DIR, file)).startsWith('mod/')) {
    if (!$('#description').length || !$('#versions').length) fail('MISSING_MOD_TAB', file, 'Description or Versions panel missing');
  }
  if (posixPath(path.relative(DOCS_DIR, file)).startsWith('addon/')) {
    if (!$('#description').length || !$('#versions').length) fail('MISSING_ADDON_TAB', file, 'Description or Versions panel missing');
  }
}

function pathExistsSync(target) {
  try {
    return Boolean(target) && requireStat(target);
  } catch { return false; }
}

function requireStat(target) {
  // Node's synchronous call is intentional here: Cheerio attribute walks are synchronous.
  return statSync(target).isFile();
}

import { statSync } from 'node:fs';

const docsBytes = await directorySize(DOCS_DIR);
if (docsBytes >= MAX_DOCS_BYTES) errors.push({ code: 'SITE_TOO_LARGE', file: 'docs', detail: `${docsBytes} bytes` });
if (manifest.assetErrors) warnings.push(`${manifest.assetErrors} source images could not be captured and use a local placeholder.`);

const report = {
  passed: errors.length === 0,
  ...metrics,
  docsBytes,
  captureErrors: manifest.errors?.length || 0,
  errors,
  warnings,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;

