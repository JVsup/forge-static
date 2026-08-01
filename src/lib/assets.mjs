import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ASSET_DIR, MAX_FILE_BYTES, SNAPSHOT_DIR } from '../config.mjs';
import { cachedRequest } from './http.mjs';
import { ensureDir, pathExists, readJson, sha256, writeJson } from './fs.mjs';

const mapFile = path.join(SNAPSHOT_DIR, 'asset-map.json');
const mimeExtensions = {
  'image/avif': '.avif', 'image/gif': '.gif', 'image/jpeg': '.jpg',
  'image/png': '.png', 'image/svg+xml': '.svg', 'image/webp': '.webp',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
};

function contentType(headers, url) {
  const clean = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (clean.startsWith('image/')) return clean;
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  return Object.entries(mimeExtensions).find(([, ext]) => ext === extension)?.[0] || 'application/octet-stream';
}

async function optimize(buffer, mime, role, profile = { content: 1920, thumbnail: 512, avatar: 256, quality: 82 }) {
  if (mime === 'image/svg+xml' || mime.includes('icon')) return { buffer, mime };
  const limit = profile[role] || profile.content;
  try {
    const source = sharp(buffer, { animated: true, limitInputPixels: 200_000_000 });
    const metadata = await source.metadata();
    const resized = source.resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true });
    const converted = await resized.webp({ quality: profile.quality, effort: 4 }).toBuffer();
    if (converted.length < buffer.length || (metadata.width || 0) > limit || (metadata.height || 0) > limit) {
      return { buffer: converted, mime: 'image/webp' };
    }
  } catch {
    // Preserve an image Sharp cannot decode; MIME is still checked by the caller.
  }
  return { buffer, mime };
}

export async function captureAssets(requests, options = {}) {
  const existing = await readJson(mapFile, {});
  const entries = [...new Map(requests.filter((item) => item?.url).map((item) => [item.url, item])).values()];
  let completed = 0;
  let cursor = 0;
  let writeGate = Promise.resolve();
  async function processItem(item) {
    const count = ++completed;
    if (existing[item.url]?.path && await pathExists(path.join(SNAPSHOT_DIR, existing[item.url].path))) return;
    if (existing[item.url]?.error) return;
    try {
      const result = await cachedRequest(item.url, { kind: 'asset', retries: 1, timeoutMs: 20_000, cache: false });
      const mime = contentType(result.headers, item.url);
      if (!mime.startsWith('image/')) throw new Error(`Not an image (${mime})`);
      if (result.body.length > MAX_FILE_BYTES) throw new Error('Source image exceeds 100 MB');
      const optimized = await optimize(result.body, mime, item.role || 'content', options.profile);
      const hash = sha256(optimized.buffer);
      const extension = mimeExtensions[optimized.mime] || '.bin';
      const relative = path.posix.join('assets', `${hash}${extension}`);
      const target = path.join(SNAPSHOT_DIR, relative);
      await ensureDir(ASSET_DIR);
      if (!await pathExists(target)) await fs.writeFile(target, optimized.buffer);
      existing[item.url] = {
        path: relative, sha256: hash, size: optimized.buffer.length,
        mime: optimized.mime, sourceMime: mime, role: item.role || 'content',
      };
    } catch (error) {
      existing[item.url] = { path: null, error: error.message, role: item.role || 'content' };
    }
    if (count % 50 === 0) {
      writeGate = writeGate.then(() => writeJson(mapFile, existing));
      await writeGate;
      console.log(`Captured ${count}/${entries.length} image URLs.`);
    }
  }
  async function worker() {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      await processItem(entries[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, entries.length || 1) }, worker));
  await writeGate;
  await writeJson(mapFile, existing);
  return existing;
}

export async function recompressAssets(assetMap, profile) {
  const remapped = { ...assetMap };
  const entries = Object.entries(remapped);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const [url, entry] = entries[index];
      if (!entry?.path || entry.mime === 'image/svg+xml' || entry.mime?.includes('icon')) {
        completed += 1;
        continue;
      }
    const sourcePath = path.join(SNAPSHOT_DIR, entry.path);
      if (!await pathExists(sourcePath)) {
        completed += 1;
        continue;
      }
    const source = await fs.readFile(sourcePath);
    const optimized = await optimize(source, entry.mime, entry.role || 'content', profile);
      if (optimized.buffer.length < source.length) {
        const hash = sha256(optimized.buffer);
        const extension = mimeExtensions[optimized.mime] || '.bin';
        const relative = path.posix.join('assets', `${hash}${extension}`);
        const target = path.join(SNAPSHOT_DIR, relative);
        if (!await pathExists(target)) await fs.writeFile(target, optimized.buffer);
        remapped[url] = { ...entry, path: relative, sha256: hash, size: optimized.buffer.length, mime: optimized.mime };
      }
      completed += 1;
      if (completed % 250 === 0) console.log(`Recompressed ${completed}/${entries.length} assets.`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, entries.length || 1) }, worker));
  const used = new Set(Object.values(remapped).map((entry) => entry?.path).filter(Boolean).map((value) => path.normalize(value)));
  for (const name of await fs.readdir(ASSET_DIR).catch(() => [])) {
    const relative = path.normalize(path.join('assets', name));
    if (!used.has(relative)) await fs.unlink(path.join(ASSET_DIR, name));
  }
  await writeJson(mapFile, remapped);
  return remapped;
}
