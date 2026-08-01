import * as cheerio from 'cheerio';
import { FORGE_HOSTS, FORGE_ORIGIN, FORGE_STATIC_ORIGIN } from '../config.mjs';

export function absoluteUrl(value, base = FORGE_ORIGIN) {
  if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

export function forgeReference(urlLike, base = FORGE_ORIGIN) {
  const resolved = absoluteUrl(urlLike, base);
  if (!resolved) return null;
  const url = new URL(resolved);
  if (!FORGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/(mod|addon)s?\/(\d+)(?:\/([^/?#]+))?/i);
  if (!match) return null;
  return { type: match[1].toLowerCase(), id: Number(match[2]), slug: match[3] || null, source: resolved };
}

export function extractForgeReferences(...htmlValues) {
  const references = new Map();
  for (const value of htmlValues.flat(Infinity).filter(Boolean)) {
    const text = String(value);
    const $ = cheerio.load(text, null, false);
    $('a[href],img[src],source[src],video[src],iframe[src]').each((_, element) => {
      const ref = forgeReference($(element).attr('href') || $(element).attr('src'));
      if (ref) references.set(`${ref.type}:${ref.id}`, ref);
    });
    for (const match of text.matchAll(/https?:\\?\/\\?\/(?:forge|forge-static)\.sp-tarkov\.com\\?\/(?:mod|addon)s?\\?\/(\d+)(?:\\?\/([\w-]+))?/gi)) {
      const typeMatch = match[0].match(/\/(mod|addon)s?\//i);
      if (typeMatch) {
        const ref = { type: typeMatch[1].toLowerCase(), id: Number(match[1]), slug: match[2] || null, source: match[0] };
        references.set(`${ref.type}:${ref.id}`, ref);
      }
    }
  }
  return [...references.values()];
}

export function extractImageUrls(html, base = FORGE_ORIGIN) {
  if (!html) return [];
  const urls = new Set();
  const $ = cheerio.load(String(html), null, false);
  $('img[src],source[src]').each((_, element) => {
    const url = absoluteUrl($(element).attr('src'), base);
    if (url && /^https?:/i.test(url)) urls.add(url);
  });
  $('img[srcset],source[srcset]').each((_, element) => {
    for (const candidate of ($(element).attr('srcset') || '').split(',')) {
      const url = absoluteUrl(candidate.trim().split(/\s+/)[0], base);
      if (url && /^https?:/i.test(url)) urls.add(url);
    }
  });
  return [...urls];
}

export function extractPageMetadata(html, ownerName = '') {
  if (!html) return { modlistCount: null, authorRoles: [] };
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const listMatch = text.match(/(?:featured|included) in\s+([\d,\. ]+)\s+(?:mod\s*)?lists?/i);
  const roles = new Set();
  if (ownerName) {
    $('a').filter((_, element) => $(element).text().trim() === ownerName).each((_, element) => {
      const context = $(element).parent().text().replace(/\s+/g, ' ').trim();
      for (const known of ['Staff', 'Administrator', 'Moderator', 'Developer', 'Author']) {
        if (new RegExp(`\\b${known}\\b`, 'i').test(context)) roles.add(known);
      }
    });
  }
  return {
    modlistCount: listMatch ? Number(listMatch[1].replace(/[^0-9]/g, '')) : null,
    authorRoles: [...roles],
  };
}

export function collectDependencyReferences(value, output = new Map()) {
  if (!value || typeof value !== 'object') return [...output.values()];
  if (Array.isArray(value)) {
    for (const item of value) collectDependencyReferences(item, output);
    return [...output.values()];
  }
  if (Number.isInteger(Number(value.id)) && (value.guid || value.slug) && (value.name || value.latest_compatible_version)) {
    output.set(`mod:${Number(value.id)}`, {
      type: 'mod', id: Number(value.id), slug: value.slug || null, source: 'dependency',
    });
  }
  for (const child of Object.values(value)) collectDependencyReferences(child, output);
  return [...output.values()];
}

export function isForgeUrl(value) {
  try {
    return FORGE_HOSTS.has(new URL(value, FORGE_ORIGIN).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const BUILTIN_ASSETS = [
  `${FORGE_ORIGIN}/favicon.svg`,
  `${FORGE_ORIGIN}/favicon-96x96.png`,
  `${FORGE_ORIGIN}/apple-touch-icon.png`,
  `${FORGE_STATIC_ORIGIN}/favicon.svg`,
];

