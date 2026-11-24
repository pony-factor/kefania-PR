#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, readdir, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Profiles are durable, reviewable files in Kefania's working tree, not an expiring cache.
export const PONY_CACHE_VERSION = 2;
export const MAX_PONY_PROFILE_BYTES = 60000;
const allowed = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const https = url => typeof url === 'string' && /^https:\/\/[^\s/@]+(?:[^\s]*)?$/i.test(url) && !url.includes('@') && url.length <= 2000;

export function ponyCacheDirectory(env = process.env) {
  return env.KEFANIA_PONY_CACHE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ponies');
}
export function ponyCacheKey(pony) {
  const pack = String(pony?.packId || '').trim().toLowerCase();
  const slug = String(pony?.canonicalSlug || pony?.slug || '').trim().toLowerCase();
  if (!allowed.test(pack) || !allowed.test(slug)) throw new Error('Invalid pony identity.');
  // Historical Sweetiebot branch slugs share the canonical profile.
  const aliases = { hoofar: 'hoo-far', 'professorbill-neigh': 'bill-neigh' };
  const canonical = pack === 'g4-stallions' && Object.hasOwn(aliases, slug) ? aliases[slug] : slug;
  return pack + '/' + canonical;
}
const filePath = (pony, directory) => join(directory, ponyCacheKey(pony) + '.json');
function validateLinks(values, artwork = false) {
  if (!Array.isArray(values) || values.length > 30) throw new Error('Invalid source/artwork list.');
  return values.map(value => {
    if (!value || !https(value.url)) throw new Error('Sources and artwork require HTTPS URLs.');
    const result = { url: value.url };
    for (const key of artwork ? ['alt', 'credit', 'source'] : ['label']) {
      if (value[key] === undefined) continue;
      if (key === 'source' ? !https(value[key]) : typeof value[key] !== 'string' || value[key].length > 500)
        throw new Error('Invalid source attribution.');
      result[key] = value[key];
    }
    return result;
  });
}
// Pack-scoped URLs are maintained alongside the durable pony records, not in
// Sweetiebot's branch-name catalog. Records may add other curated references.
function mergeReferences(...lists) {
  const seen = new Set(), combined = [];
  for (const item of lists.flat()) {
    if (!item || !https(item.url) || seen.has(item.url)) continue;
    seen.add(item.url);
    combined.push({ url: item.url, ...(typeof item.label === 'string' ? { label: item.label } : {}) });
  }
  return combined.slice(0, 30);
}
async function catalogReferences(pony, directory) {
  try {
    const [packId, slug] = ponyCacheKey(pony).split('/');
    const index = JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8'));
    if (index.version !== 1) return [];
    const entries = index.packs?.[packId]?.[slug];
    return entries ? validateLinks(entries) : [];
  } catch {
    // A missing or malformed reference index never prevents local research.
    return [];
  }
}
const compactText = (value, limit = 5000) => typeof value === 'string' && value.length <= limit ? value : '';
const boundedList = (value, limit = 500) => {
  if (!Array.isArray(value) || value.length > 30 || value.some(v => typeof v !== 'string' || v.length > limit))
    throw new Error('Invalid profile details.');
  return value;
};
function rotateArtwork(record, now) {
  if (!record.artwork?.length) return null;
  const weeks = Math.floor(now() / (7 * 86400000));
  const offset = parseInt(digest(record.packId + '/' + record.slug).slice(0, 7), 16);
  return record.artwork[(weeks + offset) % record.artwork.length];
}
export async function readPonyCache(pony, { directory = ponyCacheDirectory(), now = Date.now } = {}) {
  const key = ponyCacheKey(pony);
  const references = await catalogReferences(pony, directory);
  try {
    const raw = await readFile(filePath(pony, directory), 'utf8');
    const record = JSON.parse(raw);
    if (record.version !== PONY_CACHE_VERSION || record.packId + '/' + record.slug !== key
      || typeof record.profile !== 'string' || !record.profile.trim()
      || Buffer.byteLength(record.profile, 'utf8') > MAX_PONY_PROFILE_BYTES) {
      return references.length ? { hit: false, sources: references } : { hit: false };
    }
    record.sources = mergeReferences(record.sources || [], references);
    const featuredArtwork = rotateArtwork(record, now);
    const image = featuredArtwork
      ? '![' + (featuredArtwork.alt || record.name || record.slug).replace(/[\[\]]/g, '') + '](' + featuredArtwork.url + ')\n'
        + (featuredArtwork.source ? 'Artwork source: ' + featuredArtwork.source + '\n' : '') + '\n'
      : '';
    // Keep migrated references visible even in profiles written before the migration.
    const missing = record.sources.filter(ref => !record.profile.includes(ref.url));
    const sourceText = missing.length
      ? '\n\n### Source references\n' + missing.map(ref =>
          '- [' + (ref.label || 'Reference').replace(/[\[\]]/g, '') + '](' + ref.url + ')').join('\n')
      : '';
    return { hit: true, profile: image + record.profile + sourceText,
      record, revision: digest(raw), featuredArtwork, sources: record.sources };
  } catch {
    return references.length ? { hit: false, sources: references } : { hit: false };
  }
}
async function saveFile(path, record, createOnly = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    if (createOnly) await link(temporary, path); // Atomic create; never overwrite a curated profile.
    else await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function writePonyCache(pony, profile, { directory = ponyCacheDirectory(), now = Date.now } = {}) {
  const [packId, slug] = ponyCacheKey(pony).split('/');
  if (typeof profile !== 'string' || !profile.trim()
    || Buffer.byteLength(profile, 'utf8') > MAX_PONY_PROFILE_BYTES) throw new Error('Invalid pony profile.');
  const date = new Date(now()).toISOString();
  const references = await catalogReferences(pony, directory);
  const record = { version: PONY_CACHE_VERSION, packId, slug, name: compactText(pony.name, 200) || slug,
    status: 'draft', profile, aliases: [], appearance: '', speakingStatus: '', appearances: [],
    namingHistory: '', sources: mergeReferences(references, https(pony.source) ? [{ url: pony.source, label: 'Catalog source' }] : []),
    artwork: [], createdAt: date, updatedAt: date };
  try {
    await saveFile(filePath(pony, directory), record, true);
    return { stored: true, path: ponyCacheKey(pony) + '.json' };
  } catch (error) {
    if (error.code === 'EEXIST') return { stored: false, reason: 'existing-profile-preserved' };
    throw error;
  }
}
export async function curatePonyProfile(pony, details, { directory = ponyCacheDirectory(), now = Date.now } = {}) {
  const key = ponyCacheKey(pony);
  if (details?.approved !== true) throw new Error('Explicit approval is required to save pony research.');
  const old = await readPonyCache(pony, { directory, now });
  if (old.hit && old.revision !== details.expectedRevision) throw new Error('The profile changed; read it again before saving.');
  if (!old.hit && details.expectedRevision !== null) throw new Error('To create a profile, supply expectedRevision=null.');
  if (typeof details.profile !== 'string' || !details.profile.trim()
    || Buffer.byteLength(details.profile, 'utf8') > MAX_PONY_PROFILE_BYTES) throw new Error('Invalid pony profile.');
  const existing = old.record || {}, [packId, slug] = key.split('/');
  const date = new Date(now()).toISOString();
  const record = { version: PONY_CACHE_VERSION, packId, slug,
    name: compactText(details.name, 200) || existing.name || slug,
    status: details.status === 'reviewed' ? 'reviewed' : 'draft', profile: details.profile,
    aliases: boundedList(details.aliases ?? existing.aliases ?? [], 200),
    appearance: compactText(details.appearance ?? existing.appearance),
    speakingStatus: compactText(details.speakingStatus ?? existing.speakingStatus, 300),
    appearances: boundedList(details.appearances ?? existing.appearances ?? []),
    namingHistory: compactText(details.namingHistory ?? existing.namingHistory),
    sources: mergeReferences(validateLinks(details.sources ?? existing.sources ?? old.sources ?? []), await catalogReferences(pony, directory)),
    artwork: validateLinks(details.artwork ?? existing.artwork ?? [], true),
    createdAt: existing.createdAt || date, updatedAt: date };
  if (record.status === 'reviewed' && record.sources.length === 0)
    throw new Error('A reviewed profile requires a source URL.');
  await saveFile(filePath(pony, directory), record, !old.hit);
  return { saved: true, path: key + '.json', revision: digest(JSON.stringify(record, null, 2) + '\n'), status: record.status };
}
export async function listPonyProfiles({ directory = ponyCacheDirectory(), packId } = {}) {
  if (packId && !allowed.test(packId)) throw new Error('Invalid pony pack.');
  let packs;
  try { packs = packId ? [packId] : (await readdir(directory, { withFileTypes: true }))
    .filter(d => d.isDirectory() && allowed.test(d.name)).map(d => d.name); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const output = [];
  for (const pack of packs) {
    let files;
    try { files = await readdir(join(directory, pack)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files.filter(f => /^[a-z0-9][a-z0-9_-]*\.json$/.test(f))) {
      const slug = file.slice(0, -5), found = await readPonyCache({ packId: pack, slug }, { directory });
      if (found.hit) output.push({ packId: pack, slug, name: found.record.name,
        status: found.record.status, updatedAt: found.record.updatedAt });
    }
  }
  return output.sort((a, b) => (a.packId + '/' + a.slug).localeCompare(b.packId + '/' + b.slug));
}
export async function removePonyCache(pony, { directory = ponyCacheDirectory() } = {}) {
  const existing = await readPonyCache(pony, { directory });
  if (existing.hit && existing.record.status === 'reviewed') return { removed: false, reason: 'reviewed-profile-preserved' };
  await rm(filePath(pony, directory), { force: true });
  return { removed: true };
}
export async function ponyCacheAction(input, options = {}) {
  if (!input || typeof input !== 'object' || !input.pony) throw new Error('Missing pony metadata.');
  if (input.action === 'get') return readPonyCache(input.pony, options);
  if (input.action === 'put') return writePonyCache(input.pony, input.profile, options);
  if (input.action === 'remove') return removePonyCache(input.pony, options);
  if (input.action === 'curate') return curatePonyProfile(input.pony, input, options);
  if (input.action === 'list') return { ponies: await listPonyProfiles(options) };
  throw new Error('Unknown pony library operation.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > 100000) throw new Error('Request too large.');
    }
    console.log(JSON.stringify(await ponyCacheAction(JSON.parse(input))));
  } catch (error) {
    console.error('Pony library request failed: ' + error.message);
    process.exitCode = 1;
  }
}
