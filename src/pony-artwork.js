import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ponyCacheKey } from './pony-cache.js';

export const MAX_ARTWORK_BYTES = 12 * 1024 * 1024;
const MAX_ARTWORK = 30;
const keyFor = url => createHash('sha256').update(url).digest('hex');
const isKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
export function artworkDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artwork-cache', 'files');
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Invalid artwork URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    throw new Error('Artwork requires a direct HTTPS URL.');
  return url.href;
}
function textField(value) {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}
// Do not turn an untrusted research link into a general-purpose local HTTP proxy.
// Other HTTPS origins still get a provenance record, but are not downloaded.
function downloadable(url) {
  const host = new URL(url).hostname;
  return ['derpicdn.net', 'static.manebooru.art', 'cdn.twibooru.org',
    'www.clipartmax.com', 'static.wikia.nocookie.net'].includes(host) ||
    /^img[1-9][0-9]*\.wikia\.nocookie\.net$/.test(host);
}
function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
async function atomicWrite(path, data) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { await writeFile(temp, data, { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
function folder(pony, directory) { return join(directory, ponyCacheKey(pony)); }
async function readEntry(dir, key) {
  if (!isKey(key)) return null;
  try {
    const entry = JSON.parse(await readFile(join(dir, key + '.json'), 'utf8'));
    if (entry.key !== key || keyFor(httpsUrl(entry.url)) !== key) return null;
    httpsUrl(entry.source);
    const data = await stat(join(dir, key + '.image')).catch(() => null);
    return { key, url: entry.url, source: entry.source, alt: textField(entry.alt),
      credit: textField(entry.credit), cached: Boolean(data?.isFile() && data.size > 0 && data.size <= MAX_ARTWORK_BYTES) };
  } catch { return null; }
}
export async function listPonyArtwork(pony, { directory = artworkDirectory() } = {}) {
  const dir = folder(pony, directory);
  let files;
  try { files = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const keys = files.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort().slice(0, MAX_ARTWORK);
  return (await Promise.all(keys.map(file => readEntry(dir, file.slice(0, -5))))).filter(Boolean);
}
async function download(url, request) {
  if (!downloadable(url)) return null;
  const response = await request(url, { redirect: 'error', credentials: 'omit',
    signal: AbortSignal.timeout(8000), headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' } });
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || !['image/png','image/jpeg','image/gif','image/webp'].includes(type) ||
      /filename=["']?placeholder\./i.test(response.headers.get('content-disposition') || '') ||
      Number(response.headers.get('content-length')) > MAX_ARTWORK_BYTES || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARTWORK_BYTES) return null;
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  return imageType(bytes) === type ? bytes : null;
}
// Serialize local writes per character to enforce the gallery cap across simultaneous loads.
const pending = new Map();
export async function cachePonyArtwork(pony, artwork, { directory = artworkDirectory(), request = fetch } = {}) {
  const dir = folder(pony, directory);
  const url = httpsUrl(artwork?.url), source = httpsUrl(artwork?.source);
  const key = keyFor(url);
  const previous = pending.get(dir) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const existing = await readEntry(dir, key);
    if (!existing && (await listPonyArtwork(pony, { directory })).length >= MAX_ARTWORK) return null;
    // Keep contextual source and attribution even if the host cannot be cached.
    const record = { key, url, source, alt: textField(artwork.alt), credit: textField(artwork.credit) };
    if (existing?.cached) return existing;
    if (!existing) await atomicWrite(join(dir, key + '.json'), JSON.stringify(record, null, 2) + '\n');
    try {
      const bytes = await download(url, request);
      if (bytes) await atomicWrite(join(dir, key + '.image'), bytes);
    } catch { /* Retain provenance; unavailable artwork must not block PR work. */ }
    return readEntry(dir, key);
  });
  pending.set(dir, work);
  try { return await work; } finally { if (pending.get(dir) === work) pending.delete(dir); }
}
export async function readPonyArtwork(pony, key, { directory = artworkDirectory() } = {}) {
  const dir = folder(pony, directory);
  const entry = await readEntry(dir, key);
  if (!entry?.cached) return null;
  try {
    const bytes = await readFile(join(dir, key + '.image'));
    const type = imageType(bytes);
    return type && bytes.length <= MAX_ARTWORK_BYTES ? { bytes, type } : null;
  } catch { return null; }
}
