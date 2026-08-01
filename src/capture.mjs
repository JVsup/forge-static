import fs from 'node:fs/promises';
import path from 'node:path';
import {
  API_ORIGIN, DATA_DIR, FORGE_HOSTS, FORGE_ORIGIN, SNAPSHOT_DATE,
  SNAPSHOT_DIR, SPT_FILTER,
} from './config.mjs';
import { captureAssets } from './lib/assets.mjs';
import {
  BUILTIN_ASSETS, collectDependencyReferences, extractForgeReferences,
  extractImageUrls, extractPageMetadata, isForgeUrl,
} from './lib/content.mjs';
import { ensureDir, pathExists, readJson, sha256, writeJson } from './lib/fs.mjs';
import { fetchJson, fetchPaginated, fetchText, resolveExternalRedirect } from './lib/http.mjs';

const stateFile = path.join(SNAPSHOT_DIR, 'capture-state.json');
const manifestFile = path.join(SNAPSHOT_DIR, 'manifest.json');
const modDir = path.join(DATA_DIR, 'mods');
const addonDir = path.join(DATA_DIR, 'addons');

const state = await readJson(stateFile, {
  startedAt: SNAPSHOT_DATE,
  seedComplete: false,
  addonSeedComplete: false,
  seedCount: 0,
  modQueue: [], addonQueue: [],
  processedMods: [], processedAddons: [],
  errors: [],
});

const processedMods = new Set(state.processedMods.map(Number));
const processedAddons = new Set(state.processedAddons.map(Number));
const queuedMods = new Set(state.modQueue.map((item) => Number(item.id)));
const queuedAddons = new Set(state.addonQueue.map((item) => Number(item.id)));
const inFlightMods = new Set();
const inFlightAddons = new Set();

async function persistState() {
  state.processedMods = [...processedMods];
  state.processedAddons = [...processedAddons];
  await writeJson(stateFile, state);
}

function enqueue(type, id, slug = null, discoveredBy = 'reference') {
  id = Number(id);
  if (!Number.isInteger(id) || id <= 0) return;
  if (type === 'mod') {
    if (processedMods.has(id) || queuedMods.has(id) || inFlightMods.has(id)) return;
    queuedMods.add(id);
    state.modQueue.push({ id, slug, discoveredBy });
  } else if (type === 'addon') {
    if (processedAddons.has(id) || queuedAddons.has(id) || inFlightAddons.has(id)) return;
    queuedAddons.add(id);
    state.addonQueue.push({ id, slug, discoveredBy });
  }
}

function enqueueFromValues(values, discoveredBy) {
  const strings = [];
  const collectStrings = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectStrings);
  };
  collectStrings(values);
  for (const ref of extractForgeReferences(strings)) enqueue(ref.type, ref.id, ref.slug, discoveredBy);
  for (const ref of collectDependencyReferences(values)) enqueue('mod', ref.id, ref.slug, discoveredBy);
}

function htmlValues(record) {
  return [
    record.description, record.custom_ai_disclosure,
    ...(record.versions || []).map((version) => version.description),
  ].filter(Boolean);
}

async function resolveDownloads(record) {
  const source = record.source_code_links?.find((link) => link?.url && !isForgeUrl(link.url))?.url || null;
  let cursor = 0;
  const versions = record.versions || [];
  async function worker() {
    while (cursor < versions.length) {
      const index = cursor;
      cursor += 1;
      const version = versions[index];
    const resolved = await resolveExternalRedirect(version.link);
    if (resolved.url && !isForgeUrl(resolved.url)) {
      version.download = { type: 'external', url: resolved.url };
    } else {
      version.download = { type: 'fallback', sourceUrl: source, reason: resolved.reason || 'forge_hosted' };
    }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, versions.length || 1) }, worker));
}

async function safeHtml(url, type, id) {
  try {
    return (await fetchText(url)).text;
  } catch (error) {
    state.errors.push({ type, id, stage: 'html', message: error.message, at: new Date().toISOString() });
    return '';
  }
}

async function captureMod(item) {
  const detailUrl = new URL(`${API_ORIGIN}/mod/${item.id}`);
  detailUrl.searchParams.set('include', 'license,category,source_code_links');
  const [detailOutcome, versionsOutcome] = await Promise.allSettled([
    fetchJson(detailUrl.href),
    fetchPaginated(`${API_ORIGIN}/mod/${item.id}/versions`, {
      include: 'dependencies,virus_total_links', sort: '-version,-created_at',
    }),
  ]);
  if (detailOutcome.status === 'rejected') throw detailOutcome.reason;
  const detail = detailOutcome.value.json.data;
  const versions = versionsOutcome.status === 'fulfilled' ? versionsOutcome.value : [];
  if (versionsOutcome.status === 'rejected') state.errors.push({ type: 'mod', id: item.id, stage: 'versions', message: versionsOutcome.reason.message, at: new Date().toISOString() });
  const publicUrl = detail.detail_url || `${FORGE_ORIGIN}/mod/${item.id}/${detail.slug}`;
  const pageHtml = await safeHtml(publicUrl, 'mod', item.id);
  const page = extractPageMetadata(pageHtml, detail.owner?.name);
  const record = {
    type: 'mod', ...detail, versions,
    page, capture: {
      status: versionsOutcome.status === 'fulfilled' ? 'complete' : 'partial',
      capturedAt: new Date().toISOString(), discoveredBy: item.discoveredBy,
      error: versionsOutcome.status === 'rejected' ? versionsOutcome.reason.message : null,
    },
  };
  await writeJson(path.join(modDir, `${item.id}.json`), record);
  enqueueFromValues([record, pageHtml], `mod:${item.id}`);
  return record;
}

async function captureAddon(item) {
  const detailUrl = new URL(`${API_ORIGIN}/addon/${item.id}`);
  detailUrl.searchParams.set('include', 'license,mod,source_code_links');
  const [detailOutcome, versionsOutcome] = await Promise.allSettled([
    fetchJson(detailUrl.href),
    fetchPaginated(`${API_ORIGIN}/addon/${item.id}/versions`, {
      include: 'virus_total_links', sort: '-version,-created_at',
    }),
  ]);
  if (detailOutcome.status === 'rejected') throw detailOutcome.reason;
  const detail = detailOutcome.value.json.data;
  const versions = versionsOutcome.status === 'fulfilled' ? versionsOutcome.value : [];
  if (versionsOutcome.status === 'rejected') state.errors.push({ type: 'addon', id: item.id, stage: 'versions', message: versionsOutcome.reason.message, at: new Date().toISOString() });
  const publicUrl = detail.detail_url || `${FORGE_ORIGIN}/addon/${item.id}/${detail.slug}`;
  const pageHtml = await safeHtml(publicUrl, 'addon', item.id);
  const record = {
    type: 'addon', ...detail, versions,
    page: extractPageMetadata(pageHtml, detail.owner?.name),
    capture: {
      status: versionsOutcome.status === 'fulfilled' ? 'complete' : 'partial',
      capturedAt: new Date().toISOString(), discoveredBy: item.discoveredBy,
      error: versionsOutcome.status === 'rejected' ? versionsOutcome.reason.message : null,
    },
  };
  await writeJson(path.join(addonDir, `${item.id}.json`), record);
  if (detail.mod?.id || detail.mod_id) enqueue('mod', detail.mod?.id || detail.mod_id, detail.mod?.slug, `addon:${item.id}`);
  enqueueFromValues([record, pageHtml], `addon:${item.id}`);
  return record;
}

async function recordFailure(type, item, error) {
  const failure = {
    type, id: Number(item.id), slug: item.slug || null,
    name: item.name || `${type} ${item.id}`, description: '', teaser: '', versions: [],
    capture: { status: 'failed', capturedAt: new Date().toISOString(), discoveredBy: item.discoveredBy, error: error.message },
  };
  await writeJson(path.join(type === 'mod' ? modDir : addonDir, `${item.id}.json`), failure);
  state.errors.push({ type, id: item.id, stage: 'detail', message: error.message, at: new Date().toISOString() });
}

async function loadRecords(directory) {
  const records = [];
  if (!await pathExists(directory)) return records;
  for (const name of await fs.readdir(directory)) {
    if (name.endsWith('.json')) records.push(await readJson(path.join(directory, name)));
  }
  return records;
}

function assetRequests(records) {
  const result = BUILTIN_ASSETS.map((url) => ({ url, role: 'content' }));
  for (const record of records) {
    if (record.thumbnail) result.push({ url: record.thumbnail, role: 'thumbnail' });
    for (const author of [record.owner, ...(record.additional_authors || [])].filter(Boolean)) {
      if (author.profile_photo_url) result.push({ url: author.profile_photo_url, role: 'avatar' });
    }
    for (const html of htmlValues(record)) {
      for (const url of extractImageUrls(html)) result.push({ url, role: 'content' });
    }
  }
  return result;
}

await Promise.all([ensureDir(modDir), ensureDir(addonDir)]);

if (!state.failureRepairV2) {
  for (const id of [...processedMods]) {
    const record = await readJson(path.join(modDir, `${id}.json`), null);
    if (record?.capture?.status !== 'failed') continue;
    processedMods.delete(id);
    enqueue('mod', id, record.slug, 'failure-repair');
  }
  for (const id of [...processedAddons]) {
    const record = await readJson(path.join(addonDir, `${id}.json`), null);
    if (record?.capture?.status !== 'failed') continue;
    processedAddons.delete(id);
    enqueue('addon', id, record.slug, 'failure-repair');
  }
  state.failureRepairV2 = true;
  await persistState();
}

if (!state.seedComplete) {
  console.log(`Loading seed mods for SPT ${SPT_FILTER}…`);
  const seed = await fetchPaginated(`${API_ORIGIN}/mods`, {
    'filter[spt_version]': SPT_FILTER, include: 'category,source_code_links', sort: 'name',
  });
  state.seedCount = seed.length;
  for (const mod of seed) enqueue('mod', mod.id, mod.slug, 'seed');
  state.seedComplete = true;
  await persistState();
  console.log(`Seed contains ${seed.length} mods.`);
}

if (!state.addonSeedComplete) {
  console.log('Loading public addon index…');
  const addonSeed = await fetchPaginated(`${API_ORIGIN}/addons`, {
    include: 'mod,license,source_code_links', sort: 'name',
  });
  state.seedAddonCount = addonSeed.length;
  for (const addon of addonSeed) {
    enqueue('addon', addon.id, addon.slug, 'addon-index');
    if (addon.mod?.id || addon.mod_id) enqueue('mod', addon.mod?.id || addon.mod_id, addon.mod?.slug, `addon:${addon.id}`);
  }
  state.addonSeedComplete = true;
  await persistState();
  console.log(`Addon index contains ${addonSeed.length} addons.`);
}

let completedThisRun = 0;
while (state.modQueue.length || state.addonQueue.length) {
  const type = state.modQueue.length ? 'mod' : 'addon';
  const sourceQueue = type === 'mod' ? state.modQueue : state.addonQueue;
  const queued = type === 'mod' ? queuedMods : queuedAddons;
  const processed = type === 'mod' ? processedMods : processedAddons;
  const inFlight = type === 'mod' ? inFlightMods : inFlightAddons;
  const batch = [];
  while (sourceQueue.length && batch.length < 12) {
    const item = sourceQueue.shift();
    queued.delete(Number(item.id));
    if (!processed.has(Number(item.id)) && !inFlight.has(Number(item.id))) {
      inFlight.add(Number(item.id));
      batch.push(item);
    }
  }
  await Promise.all(batch.map(async (item) => {
    try {
      if (type === 'mod') await captureMod(item);
      else await captureAddon(item);
    } catch (error) {
      await recordFailure(type, item, error);
    }
    inFlight.delete(Number(item.id));
    processed.add(Number(item.id));
  }));
  completedThisRun += batch.length;
  await persistState();
  if (completedThisRun % 20 < batch.length) {
    console.log(`Captured ${processedMods.size} mods, ${processedAddons.size} addons; queue ${state.modQueue.length + state.addonQueue.length}.`);
  }
}

const mods = await loadRecords(modDir);
const addons = await loadRecords(addonDir);
console.log(`Resolving downloads for ${mods.length} mods and ${addons.length} addons…`);
const downloadRecords = [...mods, ...addons];
let downloadCursor = 0;
async function downloadWorker() {
  while (downloadCursor < downloadRecords.length) {
    const index = downloadCursor;
    downloadCursor += 1;
    const record = downloadRecords[index];
    const source = record.source_code_links?.find((link) => link?.url && !isForgeUrl(link.url))?.url || null;
    const needsResolution = (record.versions || []).some((version) => !version.download);
    if (needsResolution) await resolveDownloads(record);
    else {
      for (const version of record.versions || []) {
        if (version.download?.type === 'fallback') version.download.sourceUrl = source;
      }
    }
    await writeJson(path.join(record.type === 'mod' ? modDir : addonDir, `${record.id}.json`), record);
    if ((index + 1) % 25 === 0) console.log(`Resolved downloads for ${index + 1}/${downloadRecords.length} pages.`);
  }
}
await Promise.all(Array.from({ length: Math.min(4, downloadRecords.length || 1) }, downloadWorker));
console.log(`Capturing images referenced by ${mods.length} mods and ${addons.length} addons…`);
const assets = await captureAssets(assetRequests([...mods, ...addons]));
const assetValues = Object.values(assets);

const sourceMap = {};
const responseCacheDir = path.join(SNAPSHOT_DIR, 'cache', 'responses');
if (await pathExists(responseCacheDir)) {
  for (const name of await fs.readdir(responseCacheDir)) {
    if (!name.endsWith('.json')) continue;
    const meta = await readJson(path.join(responseCacheDir, name));
    const bodyName = name.replace(/\.json$/, '.body');
    const bodyPath = path.join(responseCacheDir, bodyName);
    if (!meta?.requestUrl || !await pathExists(bodyPath)) continue;
    const body = await fs.readFile(bodyPath);
    sourceMap[meta.requestUrl] = {
      cacheBody: path.posix.join('cache', 'responses', bodyName),
      finalUrl: meta.finalUrl, status: meta.status, capturedAt: meta.capturedAt,
      size: body.length, sha256: sha256(body),
    };
  }
}
await writeJson(path.join(SNAPSHOT_DIR, 'source-map.json'), sourceMap);

const manifest = {
  schemaVersion: 1,
  startedAt: state.startedAt,
  completedAt: new Date().toISOString(),
  sptFilter: SPT_FILTER,
  seedModCount: state.seedCount,
  seedAddonCount: state.seedAddonCount || 0,
  modCount: mods.length,
  addonCount: addons.length,
  recursiveModCount: mods.filter((mod) => mod.capture?.discoveredBy !== 'seed').length,
  recursiveAddonCount: addons.length,
  versionCount: [...mods, ...addons].reduce((sum, record) => sum + (record.versions?.length || 0), 0),
  assetCount: assetValues.filter((asset) => asset.path).length,
  assetErrors: assetValues.filter((asset) => !asset.path).length,
  cachedSourceCount: Object.keys(sourceMap).length,
  externalDownloads: [...mods, ...addons].flatMap((record) => record.versions || []).filter((version) => version.download?.type === 'external').length,
  downloadFallbacks: [...mods, ...addons].flatMap((record) => record.versions || []).filter((version) => version.download?.type === 'fallback').length,
  errors: state.errors,
  sourceHosts: [...new Set(Object.keys(assets).map((url) => new URL(url).hostname))].sort(),
};
await writeJson(manifestFile, manifest);
console.log(JSON.stringify(manifest, null, 2));
