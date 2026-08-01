import path from 'node:path';
import * as cheerio from 'cheerio';
import semver from 'semver';
import { forgeReference, isForgeUrl } from './content.mjs';

export function outputPath(record) {
  const type = record.type === 'addon' ? 'addon' : 'mod';
  return path.posix.join(type, String(record.id), record.slug || `${type}-${record.id}`, 'index.html');
}

export function relativeFileUrl(fromFile, toFile, directory = false) {
  let relative = path.posix.relative(path.posix.dirname(fromFile), toFile) || path.posix.basename(toFile);
  if (directory && relative.endsWith('/index.html')) relative = relative.slice(0, -'index.html'.length);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

export function recordHref(record, fromFile) {
  return relativeFileUrl(fromFile, outputPath(record), true);
}

export function makeRecordLookup(records) {
  return new Map(records.map((record) => [`${record.type}:${Number(record.id)}`, record]));
}

export function normalizeConstraint(constraint) {
  if (!constraint) return null;
  try {
    return semver.validRange(constraint, { loose: true }) ? String(constraint) : null;
  } catch {
    return null;
  }
}

export function deriveSptVersions(records) {
  const versions = new Set(['4.0.0']);
  for (const record of records) {
    for (const version of record.versions || []) {
      for (const match of String(version.spt_version_constraint || '').matchAll(/\b(\d+\.\d+(?:\.\d+)?)\b/g)) {
        const normalized = semver.coerce(match[1]);
        if (normalized && semver.gte(normalized, '4.0.0')) versions.add(normalized.version);
      }
    }
  }
  return [...versions].sort(semver.rcompare);
}

export function compatibleSptVersions(record, knownVersions) {
  const constraints = (record.versions || []).map((version) => normalizeConstraint(version.spt_version_constraint)).filter(Boolean);
  return knownVersions.filter((version) => constraints.some((constraint) => {
    try { return semver.satisfies(version, constraint, { loose: true, includePrerelease: true }); }
    catch { return false; }
  }));
}

export function prepareDependencies(value, recordLookup, fromFile) {
  if (!Array.isArray(value)) return [];
  return value.map((dependency) => {
    const record = recordLookup.get(`mod:${Number(dependency.id)}`);
    return {
      ...dependency,
      localHref: record ? recordHref(record, fromFile) : null,
      dependencies: prepareDependencies(dependency.dependencies, recordLookup, fromFile),
    };
  });
}

export function sanitizeRichHtml(html, context) {
  if (!html) return '<p class="empty-state">No description was available in the snapshot.</p>';
  const {
    currentFile, assetMap, recordLookup, placeholderHref,
    transformText = (value) => value,
  } = context;
  const $ = cheerio.load(String(html), null, false);
  $('script,style,link,meta,base,form,input,button,textarea,select,option,noscript').remove();
  $('*').each((_, element) => {
    for (const attribute of Object.keys(element.attribs || {})) {
      if (/^on/i.test(attribute) || attribute === 'style' || ['wire:navigate', 'x-data', 'x-on:click'].includes(attribute)) $(element).removeAttr(attribute);
    }
  });
  $('a[href]').each((_, element) => {
    const link = $(element);
    const href = link.attr('href') || '';
    const ref = forgeReference(href);
    if (href.startsWith('#')) {
      // Preserve in-description anchors.
    } else if (ref) {
      const target = recordLookup.get(`${ref.type}:${ref.id}`);
      if (target) link.attr('href', recordHref(target, currentFile));
      else link.replaceWith(`<span class="dead-link">${link.html() || link.text()}</span>`);
    } else if (isForgeUrl(href)) {
      link.replaceWith(`<span class="dead-link">${link.html() || link.text()}</span>`);
    } else if (/^https?:/i.test(href)) {
      link.attr('target', '_blank').attr('rel', 'noreferrer noopener');
    } else if (/^javascript:/i.test(href)) {
      link.removeAttr('href');
    }
  });
  $('img').each((_, element) => {
    const image = $(element);
    let absolute;
    try { absolute = new URL(image.attr('src') || '', 'https://forge.sp-tarkov.com').href; } catch { absolute = null; }
    const asset = absolute ? assetMap[absolute] : null;
    const source = asset?.path
      ? relativeFileUrl(currentFile, asset.path)
      : placeholderHref;
    image.attr('src', source).removeAttr('srcset').removeAttr('sizes');
    image.attr('loading', 'lazy').attr('decoding', 'async');
    if (!image.attr('alt')) image.attr('alt', 'Archived image');
  });
  $('source').remove();
  $('iframe,video,audio,object,embed').each((_, element) => {
    const media = $(element);
    const source = media.attr('src') || '';
    if (isForgeUrl(source)) media.replaceWith('<p class="unavailable-embed">Forge-hosted embed unavailable in this archive.</p>');
    else if (source) media.replaceWith(`<p><a href="${source}" target="_blank" rel="noreferrer noopener">Open external media</a></p>`);
    else media.remove();
  });
  $('*').contents().each((_, node) => {
    if (node.type !== 'text') return;
    const parent = $(node).parent();
    if (parent.closest('code,pre,kbd,samp').length) return;
    node.data = transformText(node.data);
  });
  $('[alt],[title]').each((_, element) => {
    const item = $(element);
    if (item.closest('code,pre,kbd,samp').length) return;
    for (const attribute of ['alt', 'title']) {
      if (item.attr(attribute) !== undefined) item.attr(attribute, transformText(item.attr(attribute)));
    }
  });
  return $.html();
}
