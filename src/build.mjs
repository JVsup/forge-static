import fs from 'node:fs/promises';
import path from 'node:path';
import nunjucks from 'nunjucks';
import {
  ASSET_DIR, DATA_DIR, DOCS_DIR, SNAPSHOT_DIR, STATIC_DIR, TEMPLATE_DIR,
} from './config.mjs';
import { isForgeUrl } from './lib/content.mjs';
import { recompressAssets } from './lib/assets.mjs';
import { directorySize, ensureDir, pathExists, readJson, writeJson } from './lib/fs.mjs';
import {
  compatibleSptVersions, deriveSptVersions, makeRecordLookup, outputPath,
  prepareDependencies, recordHref, relativeFileUrl, sanitizeRichHtml,
} from './lib/render.mjs';

async function loadRecords(type) {
  const directory = path.join(DATA_DIR, type === 'mod' ? 'mods' : 'addons');
  if (!await pathExists(directory)) return [];
  const records = [];
  for (const name of await fs.readdir(directory)) {
    if (name.endsWith('.json')) records.push(await readJson(path.join(directory, name)));
  }
  return records.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'));
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-GB').format(Number(value || 0));
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** power)).toFixed(power ? 1 : 0)} ${units[power]}`;
}

let [mods, addons, assetMap, manifest] = await Promise.all([
  loadRecords('mod'), loadRecords('addon'),
  readJson(path.join(SNAPSHOT_DIR, 'asset-map.json'), {}),
  readJson(path.join(SNAPSHOT_DIR, 'manifest.json'), {}),
]);
if (!mods.length) throw new Error('No captured mods found. Run npm run capture first.');

const compressionProfiles = [
  { content: 1600, thumbnail: 512, avatar: 256, quality: 72 },
  { content: 1280, thumbnail: 448, avatar: 224, quality: 60 },
  { content: 1024, thumbnail: 384, avatar: 192, quality: 45 },
];
for (const profile of compressionProfiles) {
  if (await directorySize(ASSET_DIR) < 880 * 1024 * 1024) break;
  console.log(`Asset directory is large; recompressing at ${profile.content}px/q${profile.quality}…`);
  assetMap = await recompressAssets(assetMap, profile);
}

await fs.rm(DOCS_DIR, { recursive: true, force: true });
await Promise.all([ensureDir(DOCS_DIR), ensureDir(path.join(DOCS_DIR, 'assets'))]);
await Promise.all([
  fs.cp(STATIC_DIR, path.join(DOCS_DIR, 'static'), { recursive: true }),
  pathExists(ASSET_DIR).then((exists) => exists && fs.cp(ASSET_DIR, path.join(DOCS_DIR, 'assets'), { recursive: true })),
]);
await fs.writeFile(path.join(DOCS_DIR, '.nojekyll'), '');

const env = nunjucks.configure(TEMPLATE_DIR, { autoescape: true, noCache: true });
env.addFilter('date', formatDate);
env.addFilter('number', formatNumber);
env.addFilter('bytes', formatBytes);

const allRecords = [...mods, ...addons];
const recordLookup = makeRecordLookup(allRecords);
const addonsByMod = new Map();
for (const addon of addons) {
  const parentId = Number(addon.mod?.id || addon.mod_id);
  if (!Number.isInteger(parentId)) continue;
  if (!addonsByMod.has(parentId)) addonsByMod.set(parentId, []);
  addonsByMod.get(parentId).push(addon);
}
const sptVersions = deriveSptVersions(mods);
const snapshotDate = manifest.completedAt || manifest.startedAt || new Date().toISOString();
const placeholder = 'static/image-unavailable.svg';

function prepareRecord(record, currentFile) {
  const assetHref = (sourceUrl, fallback = placeholder) => {
    const asset = sourceUrl ? assetMap[sourceUrl] : null;
    return relativeFileUrl(currentFile, asset?.path || fallback);
  };
  const prepared = {
    ...record,
    page: record.page || { modlistCount: null, authorRoles: [] },
    source_code_links: (record.source_code_links || []).filter((source) => source?.url && !isForgeUrl(source.url)),
    href: recordHref(record, currentFile),
    thumbnailHref: assetHref(record.thumbnail),
    owner: record.owner ? { ...record.owner, avatarHref: assetHref(record.owner.profile_photo_url) } : null,
    additional_authors: (record.additional_authors || []).map((author) => ({ ...author, avatarHref: assetHref(author.profile_photo_url) })),
    sptVersions: compatibleSptVersions(record, sptVersions),
  };
  prepared.descriptionHtml = sanitizeRichHtml(record.description, {
    currentFile, assetMap, recordLookup, placeholderHref: relativeFileUrl(currentFile, placeholder),
  });
  prepared.aiDisclosureHtml = record.custom_ai_disclosure ? sanitizeRichHtml(record.custom_ai_disclosure, {
    currentFile, assetMap, recordLookup, placeholderHref: relativeFileUrl(currentFile, placeholder),
  }) : '';
  prepared.versions = (record.versions || []).slice().map((version) => ({
    ...version,
    descriptionHtml: sanitizeRichHtml(version.description, {
      currentFile, assetMap, recordLookup, placeholderHref: relativeFileUrl(currentFile, placeholder),
    }),
    dependencies: prepareDependencies(version.dependencies, recordLookup, currentFile),
  }));
  if (record.type === 'mod') {
    prepared.addons = (addonsByMod.get(Number(record.id)) || []).map((addon) => prepareCard(addon, currentFile));
  }
  if (record.type === 'addon') {
    const parent = recordLookup.get(`mod:${Number(record.mod?.id || record.mod_id)}`);
    prepared.parent = parent ? prepareCard(parent, currentFile) : null;
  }
  return prepared;
}

function prepareCard(record, currentFile) {
  const asset = record.thumbnail ? assetMap[record.thumbnail] : null;
  return {
    ...record,
    href: recordHref(record, currentFile),
    thumbnailHref: relativeFileUrl(currentFile, asset?.path || placeholder),
    sptVersions: compatibleSptVersions(record, sptVersions),
    searchText: [record.name, record.teaser, record.owner?.name, ...(record.additional_authors || []).map((a) => a.name), record.guid].filter(Boolean).join(' ').toLowerCase(),
  };
}

function common(currentFile) {
  return {
    currentFile, snapshotDate, manifest, sptVersions,
    homeHref: relativeFileUrl(currentFile, 'index.html', true),
    modsHref: relativeFileUrl(currentFile, 'mods/index.html', true),
    addonsHref: relativeFileUrl(currentFile, 'addons/index.html', true),
    cssHref: relativeFileUrl(currentFile, 'static/archive.css'),
    responsiveCssHref: relativeFileUrl(currentFile, 'static/responsive-fixes.css'),
    jsHref: relativeFileUrl(currentFile, 'static/archive.js'),
  };
}

async function renderTo(relative, template, context) {
  const target = path.join(DOCS_DIR, ...relative.split('/'));
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, env.render(template, { ...common(relative), ...context }));
}

await renderTo('index.html', 'index.njk', {
  title: 'The Forge static archive', heading: 'Archived mods', showAddons: true,
  mods: mods.map((record) => prepareCard(record, 'index.html')),
  addons: addons.map((record) => prepareCard(record, 'index.html')),
  categories: [...new Set(mods.map((record) => record.category?.name).filter(Boolean))].sort(),
});
await renderTo('mods/index.html', 'index.njk', {
  title: 'Archived mods', heading: 'All archived mods', showAddons: false,
  mods: mods.map((record) => prepareCard(record, 'mods/index.html')),
  categories: [...new Set(mods.map((record) => record.category?.name).filter(Boolean))].sort(),
});
await renderTo('addons/index.html', 'index.njk', {
  title: 'Archived addons', heading: 'All archived addons', addonOnly: true,
  mods: addons.map((record) => prepareCard(record, 'addons/index.html')),
  categories: [],
});

for (const record of allRecords) {
  const relative = outputPath(record);
  await renderTo(relative, 'detail.njk', {
    title: record.name,
    record: prepareRecord(record, relative),
  });
}

const completedManifest = {
  ...manifest,
  builtAt: new Date().toISOString(),
  docsBytes: await directorySize(DOCS_DIR),
};
await Promise.all([
  writeJson(path.join(DOCS_DIR, 'archive-manifest.json'), completedManifest),
  writeJson(path.join(SNAPSHOT_DIR, 'manifest.json'), completedManifest),
]);
console.log(`Built ${mods.length} mod pages and ${addons.length} addon pages in docs/.`);
