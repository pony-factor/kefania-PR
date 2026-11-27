import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePonyArtwork, listPonyArtwork } from '../src/pony-artwork.js';
const pony = { packId: 'g4-mares', slug: 'quiet-gestures' };
const art = { url: 'https://derpicdn.net/img/example.png', source: 'https://derpibooru.org/images/42',
  alt: 'Quiet Gestures', credit: 'Show capture · Hasbro (via Derpibooru)' };
async function sandbox(run) {
  const directory = await mkdtemp(join(tmpdir(), 'kefania-artwork-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('artwork is an immutable, attributed URL record with no downloaded bytes', () => sandbox(async directory => {
  const entry = await cachePonyArtwork(pony, art, { directory });
  assert.equal(entry.credit, art.credit);
  assert.equal(entry.source, art.source);
  assert.equal(entry.path, 'artwork-cache/g4-mares/quiet-gestures/' + entry.key + '.json');
  assert.deepEqual(await listPonyArtwork(pony, { directory }), [entry]);
  const folder = join(directory, 'g4-mares', 'quiet-gestures');
  assert.deepEqual(await readdir(folder), [entry.key + '.json']);
  assert.equal(JSON.parse(await readFile(join(folder, entry.key + '.json'), 'utf8')).url, art.url);
  assert.deepEqual(await cachePonyArtwork(pony, { ...art, credit: 'Replacement' }, { directory }), entry);
  assert.deepEqual(await listPonyArtwork({ ...pony, slug: 'other' }, { directory }), []);
}));
test('only HTTPS links are recorded and URL identity is canonical', () => sandbox(async directory => {
  await assert.rejects(cachePonyArtwork(pony, { ...art, url: 'http://example.org/image' }, { directory }), /HTTPS/);
  await assert.rejects(cachePonyArtwork(pony, { ...art, source: 'https://user:secret@example.org/' }, { directory }), /HTTPS/);
  const entry = await cachePonyArtwork(pony, { ...art, url: 'https://example.org/image.png' }, { directory });
  assert.equal(entry.url, 'https://example.org/image.png');
  assert.equal((await listPonyArtwork(pony, { directory })).length, 1);
}));
