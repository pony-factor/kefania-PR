import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPonyCache, writePonyCache, removePonyCache, ponyCacheAction,
  ponyCacheKey, curatePonyProfile, listPonyProfiles, MAX_PONY_PROFILE_BYTES,
} from '../src/pony-cache.js';

async function sandbox(run) {
  const directory = await mkdtemp(join(tmpdir(), 'kefania-ponies-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const pony = { packId: 'g4-mares', slug: 'magical-ponycelena',
  canonicalSlug: 'celena', name: 'Celena', source: 'https://example.org/celena' };

test('permanent readable files unify aliases and isolate generations', async () => sandbox(async directory => {
  assert.deepEqual(await readPonyCache(pony, { directory }), { hit: false });
  assert.equal((await writePonyCache(pony, 'Sourced permanent profile.', { directory })).stored, true);
  const entry = await readPonyCache({ ...pony, slug: 'celena' }, { directory, now: () => Date.now() + 1000 * 86400 * 365 });
  assert.equal(entry.hit, true, 'Profiles do not expire over time.');
  assert.match(entry.profile, /^Sourced permanent profile\./);
  assert.match(entry.profile, /https:\/\/example\.org\/celena/, 'Stored source references remain visible');
  assert.equal(entry.record.status, 'draft');
  assert.equal(ponyCacheKey(pony), 'g4-mares/celena');
  assert.equal((await readdir(join(directory, 'g4-mares')))[0], 'celena.json');
  assert.equal((await readPonyCache({ ...pony, packId: 'g5-mares' }, { directory })).hit, false);
  assert.equal((await readPonyCache({ ...pony, source: 'https://example.org/new' }, { directory })).hit, true);
  assert.deepEqual(await listPonyProfiles({ directory }), [{
    packId: 'g4-mares', slug: 'celena', name: 'Celena', status: 'draft', updatedAt: entry.record.updatedAt,
  }]);
  assert.equal((await writePonyCache(pony, 'Unreviewed replacement!', { directory })).stored, false);
  assert.equal((await readPonyCache(pony, { directory })).record.profile, 'Sourced permanent profile.');
  assert.deepEqual(await removePonyCache(pony, { directory }), { removed: true });
  assert.deepEqual(await readPonyCache(pony, { directory }), { hit: false });
}));

test('curation requires approval, citations for reviewed status and fresh revision', async () => sandbox(async directory => {
  await writePonyCache(pony, 'Initial research', { directory });
  const current = await readPonyCache(pony, { directory });
  const changes = { expectedRevision: current.revision, status: 'reviewed',
    profile: 'Verified character biography', artwork: [
      { url: 'https://example.org/art-1.png', alt: 'Portrait one', source: 'https://example.org/gallery' },
      { url: 'https://example.org/art-2.png', alt: 'Portrait two', credit: 'Artist credited' },
    ], aliases: ['Stage name'], sources: [{ url: 'https://example.org/reference', label: 'Episode credits' }] };
  await assert.rejects(curatePonyProfile(pony, changes, { directory }), /approval/);
  const approved = { ...changes, approved: true };
  const saved = await curatePonyProfile(pony, approved, { directory, now: () => 1700000000000 });
  assert.equal(saved.saved, true);
  const first = await readPonyCache(pony, { directory, now: () => 1700000000000 });
  const next = await readPonyCache(pony, { directory, now: () => 1700000000000 + 7 * 86400000 });
  assert.notEqual(first.featuredArtwork.url, next.featuredArtwork.url, 'Artwork rotates weekly.');
  assert.equal(first.record.profile, next.record.profile, 'Written biography remains stable.');
  assert.match(first.profile, /!\[Portrait/);
  assert.equal(first.record.status, 'reviewed');
  assert.equal(first.record.aliases[0], 'Stage name');
  await assert.rejects(curatePonyProfile(pony, approved, { directory }), /changed/);
  assert.deepEqual(await removePonyCache(pony, { directory }),
    { removed: false, reason: 'reviewed-profile-preserved' });
  assert.equal((await writePonyCache(pony, 'Automatic lookup', { directory })).stored, false);
  assert.equal((await readPonyCache(pony, { directory })).record.profile, 'Verified character biography');
  const raw = JSON.parse(await readFile(join(directory, 'g4-mares', 'celena.json'), 'utf8'));
  assert.equal(raw.version, 2);
}));

test('rejects path traversal, bad links and invalid research', async () => sandbox(async directory => {
  assert.throws(() => ponyCacheKey({ packId: 'g4', slug: '../../secrets' }), /Invalid pony/);
  await assert.rejects(writePonyCache(pony, ' ', { directory }), /Invalid pony profile/);
  await assert.rejects(writePonyCache(pony, '🦄'.repeat(Math.ceil(MAX_PONY_PROFILE_BYTES / 4) + 1), { directory }), /Invalid pony profile/);
  await assert.rejects(curatePonyProfile(pony, {
    approved: true, expectedRevision: null, status: 'reviewed', profile: 'No sources',
  }, { directory }), /source URL/);
  await assert.rejects(curatePonyProfile(pony, {
    approved: true, expectedRevision: null, profile: 'Research',
    artwork: [{ url: 'http://untrusted.example/art.png' }],
  }, { directory }), /HTTPS/);
  assert.deepEqual(await ponyCacheAction({ action: 'get', pony }, { directory }), { hit: false });
  assert.deepEqual(await listPonyProfiles({ directory }), []);
}));

test('pack references survive the migration and enrich first research without a stub profile', async () => sandbox(async directory => {
  const leaf = { packId: 'fandom-ocs', slug: 'leaf-litter', name: 'Leaf Litter' };
  const references = [
    { url: 'https://x.com/cheekibat/status/2111134531751493961', label: 'Character post' },
    { url: 'https://x.com/cheekibat/status/2111066237820133658', label: 'Artwork and context' },
  ];
  await writeFile(join(directory, 'sources.json'), JSON.stringify({
    version: 1, packs: { 'fandom-ocs': { 'leaf-litter': references } },
  }));
  const missing = await readPonyCache(leaf, { directory });
  assert.equal(missing.hit, false, 'References alone must not skip independent research');
  assert.deepEqual(missing.sources, references);
  const first = await writePonyCache(leaf, 'Newly researched character biography.', { directory });
  assert.equal(first.stored, true);
  const cached = await readPonyCache(leaf, { directory });
  assert.equal(cached.hit, true);
  assert.deepEqual(cached.record.sources, references);
  assert.match(cached.profile, /### Source references/);
  assert(cached.profile.includes(references[1].url), 'Both source pages should appear in the profile');
  assert.equal((await writePonyCache(leaf, 'Do not overwrite', { directory })).stored, false);

  await curatePonyProfile(leaf, {
    approved: true, expectedRevision: cached.revision, status: 'reviewed',
    profile: 'Verified original character.', sources: [],
  }, { directory });
  const reviewed = await readPonyCache(leaf, { directory });
  assert.equal(reviewed.record.status, 'reviewed');
  assert.deepEqual(reviewed.record.sources, references,
    'Even explicit curation must not silently discard migrated reference pages');
}));

test('Hoo\'Far uses a hyphenated canonical cache key while accepting legacy slugs', async () => {
  const old = { packId: 'g4-stallions', slug: 'hoofar' };
  const canonical = { packId: 'g4-stallions', slug: 'hoo-far' };
  assert.equal(ponyCacheKey(old), 'g4-stallions/hoo-far');
  assert.equal(ponyCacheKey(canonical), 'g4-stallions/hoo-far');
  const legacy = await readPonyCache(old);
  const modern = await readPonyCache(canonical);
  assert.equal(legacy.hit, true);
  assert.equal(modern.hit, true);
  assert.equal(modern.record.slug, 'hoo-far');
  assert.equal(modern.record.name, "Hoo'Far");
  assert.deepEqual(legacy.record, modern.record);
});

test('the checked-in catalog reference index retains both Leaf Litter posts', async () => {
  const index = JSON.parse(await readFile(new URL('../ponies/sources.json', import.meta.url), 'utf8'));
  assert.equal(index.version, 1);
  const urls = index.packs['fandom-ocs']['leaf-litter'].map(source => source.url);
  assert.deepEqual(urls, [
    'https://x.com/cheekibat/status/2111134531751493961',
    'https://x.com/cheekibat/status/2111066237820133658',
  ]);
  const migrated = Object.values(index.packs).flatMap(pack => Object.values(pack));
  assert.equal(migrated.length, 119);
  assert.equal(migrated.reduce((total, refs) => total + refs.length, 0), 120);
});

test('Bill Neigh uses one canonical profile for current and historical branch slugs', async () => {
  const old = { packId: 'g4-stallions', slug: 'professorbill-neigh' };
  const canonical = { packId: 'g4-stallions', slug: 'bill-neigh' };
  assert.equal(ponyCacheKey(old), 'g4-stallions/bill-neigh');
  assert.equal(ponyCacheKey(canonical), 'g4-stallions/bill-neigh');
  const legacy = await readPonyCache(old);
  const modern = await readPonyCache(canonical);
  assert.equal(legacy.hit, true);
  assert.equal(modern.hit, true);
  assert.equal(modern.record.slug, 'bill-neigh');
  assert.equal(modern.record.name, 'Bill Neigh');
  assert.deepEqual(legacy.record, modern.record);
  assert.equal(ponyCacheKey({ ...old, packId: 'g5-stallions' }), 'g5-stallions/professorbill-neigh');
});
