import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, link, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ponyCacheKey } from './pony-cache.js';

const MAX_ARTWORK = 30;
const keyFor = url => createHash('sha256').update(url).digest('hex');
export function artworkDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artwork-cache');
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Invalid artwork URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('Artwork requires a public HTTPS URL.');
  return url.href;
}
const textField = value => typeof value === 'string' ? value.trim().slice(0, 500) : '';
const recordPath = (pony, key) => 'artwork-cache/' + ponyCacheKey(pony) + '/' + key + '.json';
async function readEntry(pony, dir, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) return null;
  try {
    const entry = JSON.parse(await readFile(join(dir, key + '.json'), 'utf8'));
    const [packId, slug] = ponyCacheKey(pony).split('/');
    if (entry.version !== 1 || entry.packId !== packId || entry.slug !== slug ||
        entry.key !== key || keyFor(httpsUrl(entry.url)) !== key) return null;
    return { key, url: httpsUrl(entry.url), source: httpsUrl(entry.source), alt: textField(entry.alt),
      credit: textField(entry.credit), path: recordPath(pony, key) };
  } catch { return null; }
}
export async function listPonyArtwork(pony, { directory = artworkDirectory() } = {}) {
  const dir = join(directory, ponyCacheKey(pony));
  let files;
  try { files = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const keys = files.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort().slice(0, MAX_ARTWORK);
  return (await Promise.all(keys.map(file => readEntry(pony, dir, file.slice(0, -5))))).filter(Boolean);
}
// Store immutable, Git-trackable references only. Never fetch, proxy or write image bytes.
const pending = new Map();
export async function cachePonyArtwork(pony, artwork, { directory = artworkDirectory() } = {}) {
  const identity = ponyCacheKey(pony), dir = join(directory, identity);
  const url = httpsUrl(artwork?.url), source = httpsUrl(artwork?.source);
  const key = keyFor(url);
  const previous = pending.get(dir) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const existing = await readEntry(pony, dir, key);
    if (existing) return existing;
    if ((await listPonyArtwork(pony, { directory })).length >= MAX_ARTWORK) return null;
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const [packId, slug] = identity.split('/');
    const record = { version: 1, packId, slug, key, url, source,
      alt: textField(artwork.alt), credit: textField(artwork.credit) };
    const target = join(dir, key + '.json');
    const temp = target + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
      try { await link(temp, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await rm(temp, { force: true }); }
    return readEntry(pony, dir, key);
  });
  pending.set(dir, work);
  try { return await work; } finally { if (pending.get(dir) === work) pending.delete(dir); }
}
