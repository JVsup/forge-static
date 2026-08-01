import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleTextTransformer } from '../src/lib/text-transform.mjs';
import { sanitizeRichHtml } from '../src/lib/render.mjs';

const transform = createVisibleTextTransformer([
  'Old Tarkov Movement (No Inertia)',
  "Utanu's Tarkov Texture Pack",
]);

test('replaces company names and acronyms without regard to case', () => {
  assert.equal(transform('Battlestate Games and BSG'), 'Big Silly Goose and Big Silly Goose');
  assert.equal(transform('battlestate games and bsg'), 'Big Silly Goose and Big Silly Goose');
});

test('replaces standalone Tarkov and keeps punctuation', () => {
  assert.equal(transform("Tarkov, Tarkov’s and TARKOV's"), "THE CITY, THE CITY’s and THE CITY's");
});

test('does not replace Tarkov inside compound identifiers', () => {
  assert.equal(transform('TarkovCraft SPTarkov TarkovLike'), 'TarkovCraft SPTarkov TarkovLike');
});

test('does not alter visible URLs', () => {
  assert.equal(
    transform('Docs: https://www.sp-tarkov.com/path and www.sp-tarkov.com.'),
    'Docs: https://www.sp-tarkov.com/path and www.sp-tarkov.com.',
  );
});

test('preserves complete mod and addon names wherever they occur', () => {
  assert.equal(
    transform("Use Old Tarkov Movement (No Inertia) with Utanu's Tarkov Texture Pack in Tarkov."),
    "Use Old Tarkov Movement (No Inertia) with Utanu's Tarkov Texture Pack in THE CITY.",
  );
});

test('rich HTML transforms prose and alt text but preserves code and URL labels', () => {
  const html = sanitizeRichHtml(
    '<p>Tarkov <code>Tarkov</code> <a href="https://example.com/tarkov">https://example.com/tarkov</a> <img src="missing.png" alt="Tarkov map"></p>',
    {
      currentFile: 'mod/1/example/index.html',
      assetMap: {},
      recordLookup: new Map(),
      placeholderHref: '../../../static/image-unavailable.svg',
      transformText: transform,
    },
  );
  assert.match(html, /<p>THE CITY <code>Tarkov<\/code>/);
  assert.match(html, />https:\/\/example\.com\/tarkov<\/a>/);
  assert.match(html, /alt="THE CITY map"/);
});
