import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePonyArtwork, listPonyArtwork, readPonyArtwork } from '../src/pony-artwork.js';
const pony = { packId: 'g4-mares', slug: 'quiet-gestures' };
const art = { url: 'https://derpicdn.net/img/example.png', source: 'https://derpibooru.org/images/42',
  alt: 'Quiet Gestures', credit: 'Show capture · Hasbro (via Derpibooru)' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
async function sandbox(run) {
  const directory = await mkdtemp(join(tmpdir(), 'kefania-artwork-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('artwork keeps source, credit and bytes independently of biography', () => sandbox(async directory => {
  let calls = 0;
  const request = async (url, options) => {
    calls++; assert.equal(url, art.url); assert.equal(options.redirect, 'error');
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  const entry = await cachePonyArtwork(pony, art, { directory, request });
  assert.equal(entry.cached, true);
  assert.equal(entry.credit, art.credit);
  assert.equal(entry.source, art.source);
  assert.deepEqual(await listPonyArtwork(pony, { directory }), [entry]);
  assert.deepEqual((await readPonyArtwork(pony, entry.key, { directory })).bytes, png);
  assert.equal(JSON.parse(await readFile(join(directory, 'g4-mares', 'quiet-gestures', entry.key + '.json'), 'utf8')).source, art.source);
  assert.deepEqual(await cachePonyArtwork(pony, art, { directory, request }), entry);
  assert.equal(calls, 1);
  assert.equal(await readPonyArtwork({ ...pony, slug: 'other' }, entry.key, { directory }), null);
  assert.equal(await readPonyArtwork(pony, '../secret', { directory }), null);
}));
test('unapproved hosts and non-raster responses retain provenance only', () => sandbox(async directory => {
  const external = await cachePonyArtwork(pony, { ...art, url: 'https://example.org/img.png' }, {
    directory, request: async () => assert.fail('Unexpected external download'),
  });
  assert.equal(external.cached, false);
  const invalid = await cachePonyArtwork(pony, art, { directory,
    request: async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/png' } }) });
  assert.equal(invalid.cached, false);
  assert.equal(await readPonyArtwork(pony, invalid.key, { directory }), null);
  await assert.rejects(cachePonyArtwork(pony, { ...art, url: 'http://127.0.0.1/image' }, { directory }), /HTTPS/);
  assert.equal((await listPonyArtwork(pony, { directory })).length, 2);
}));
