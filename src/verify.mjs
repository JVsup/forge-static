import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import {
  DATA_DIR, DOCS_DIR, FORGE_HOSTS, MAX_DOCS_BYTES, MAX_FILE_BYTES, SNAPSHOT_DIR,
} from './config.mjs';
import { collectDependencyReferences, extractForgeReferences } from './lib/content.mjs';
import { directorySize, listFiles, pathExists, posixPath, readJson } from './lib/fs.mjs';
import { outputPath } from './lib/render.mjs';
import { createVisibleTextTransformer } from './lib/text-transform.mjs';

const NOTICE_COPY = 'This archive is provided as-is and will not be maintained or updated. No warranties, guarantees, or support are provided—take it or leave it.';
const MOD_INTRO = 'This archive focuses on mods for SPT 4.0.0 and newer, including recursively archived dependencies. Every archived mod is listed here; search and filters run only in your browser.';
const ADDON_INTRO = 'Addons connected to the archived SPT 4.0.0+ mod collection are listed here. Search and filters run only in your browser.';

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

function renderedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
const allRecords = [...mods, ...addons];
const protectedDisplayNames = allRecords.flatMap((record) => [
  record.name,
  record.owner?.name,
  ...(record.additional_authors || []).map((author) => author.name),
]);
const transformText = createVisibleTextTransformer(protectedDisplayNames);
const recordsByOutput = new Map(allRecords.map((record) => [outputPath(record), record]));
metrics.mods = mods.length;
metrics.addons = addons.length;
metrics.versions = allRecords.reduce((sum, record) => sum + (record.versions?.length || 0), 0);
metrics.externalDownloads = allRecords.flatMap((record) => record.versions || []).filter((version) => version.download?.type === 'external').length;
metrics.downloadFallbacks = allRecords.flatMap((record) => record.versions || []).filter((version) => version.download?.type === 'fallback').length;

if (!mods.length) errors.push({ code: 'NO_MODS', file: '', detail: 'No captured mods found' });
if (state.modQueue?.length || state.addonQueue?.length) errors.push({ code: 'OPEN_GRAPH', file: 'snapshot/capture-state.json', detail: `${state.modQueue?.length || 0} mods and ${state.addonQueue?.length || 0} addons remain queued` });
if (manifest.seedModCount && manifest.seedModCount !== state.seedCount) errors.push({ code: 'SEED_MISMATCH', file: 'snapshot/manifest.json', detail: 'Seed count differs from capture state' });

const recordKeys = new Set(allRecords.map((record) => `${record.type}:${Number(record.id)}`));
for (const record of allRecords) {
  const output = path.join(DOCS_DIR, ...outputPath(record).split('/'));
  if (!await pathExists(output)) fail('MISSING_PAGE', output, `${record.type}:${record.id}`);
  const richValues = [record.description, record.custom_ai_disclosure, ...(record.versions || []).map((version) => version.description)];
  for (const ref of extractForgeReferences(richValues)) {
    if (!recordKeys.has(`${ref.type}:${ref.id}`)) fail('UNCLOSED_GRAPH', output, `${ref.type}:${ref.id}`);
  }
  for (const version of record.versions || []) {
    for (const dependency of collectDependencyReferences(version.dependencies || [])) {
      if (!recordKeys.has(`mod:${dependency.id}`)) fail('UNCLOSED_DEPENDENCY', output, `mod:${dependency.id}`);
    }
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
  const relative = posixPath(path.relative(DOCS_DIR, file));
  const expectedRecord = recordsByOutput.get(relative);
  const notice = renderedText($('.archive-notice .shell').text());
  if (!notice.includes(NOTICE_COPY)) fail('INVALID_ARCHIVE_NOTICE', file, notice);
  if (expectedRecord && renderedText($('main h1').first().text()) !== renderedText(expectedRecord.name)) {
    fail('CHANGED_RECORD_NAME', file, `Expected ${expectedRecord.name}, found ${$('main h1').first().text().trim()}`);
  }
  $('.hero-teaser *, .hero-teaser, .teaser *, .teaser, .prose *, .prose').contents().each((_, node) => {
    if (node.type !== 'text') return;
    const parent = $(node).parent();
    if (parent.closest('code,pre,kbd,samp').length) return;
    if (transformText(node.data) !== node.data) fail('UNTRANSFORMED_VISIBLE_TEXT', file, node.data.trim());
  });
  $('.prose [alt], .prose [title]').each((_, element) => {
    for (const attribute of ['alt', 'title']) {
      const value = $(element).attr(attribute);
      if (value !== undefined && transformText(value) !== value) fail('UNTRANSFORMED_ACCESSIBLE_TEXT', file, `${attribute}=${value}`);
    }
  });
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
  if ($('form').length) fail('FORBIDDEN_FORM', file, `${$('form').length} forms found`);
  $('.nuked').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (text !== 'nuked from forge, try source code url') fail('INVALID_FALLBACK_TEXT', file, text);
  });
  if (relative.startsWith('mod/')) {
    if (!$('#description').length || !$('#versions').length) fail('MISSING_MOD_TAB', file, 'Description or Versions panel missing');
  }
  if (relative.startsWith('addon/')) {
    if (!$('#description').length || !$('#versions').length) fail('MISSING_ADDON_TAB', file, 'Description or Versions panel missing');
  }
}

for (const [relative, expectedRecords, expectedHeading, expectedIntro] of [
  ['index.html', mods, 'Archived SPT 4.0.0+ mods', MOD_INTRO],
  ['mods/index.html', mods, 'All archived SPT 4.0.0+ mods', MOD_INTRO],
  ['addons/index.html', addons, 'All archived addons', ADDON_INTRO],
]) {
  const file = path.join(DOCS_DIR, ...relative.split('/'));
  if (!await pathExists(file)) {
    fail('MISSING_INDEX', file, relative);
    continue;
  }
  const $ = cheerio.load(await fs.readFile(file, 'utf8'));
  const cards = $('[data-card-grid]').first().find('[data-archive-card]');
  if (cards.length !== expectedRecords.length) fail('INDEX_CARD_COUNT', file, `Expected ${expectedRecords.length}, found ${cards.length}`);
  const actualNames = cards.find('h2 a').map((_, item) => renderedText($(item).text())).get();
  const expectedNames = expectedRecords.slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'))
    .map((record) => renderedText(record.name));
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) fail('CHANGED_INDEX_NAMES', file, 'Rendered item names differ from the snapshot');
  if ($('.index-hero h1').text().trim() !== expectedHeading) fail('INVALID_INDEX_HEADING', file, $('.index-hero h1').text().trim());
  if ($('.index-hero > p').not('.kicker').first().text().trim() !== expectedIntro) fail('INVALID_INDEX_INTRO', file, $('.index-hero > p').not('.kicker').first().text().trim());
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
