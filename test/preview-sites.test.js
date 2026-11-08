import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewActions, previewIdentity, previewLabel } from '../src/preview-sites.js';

const args = { owner: 'upstream', repo: 'regional-starter', headRepository: 'person/regional-starter',
  head: 'feature/login', base: 'main', zone: 'example.com' };
const headSha = 'a'.repeat(40);
const context = { headSha, existingPullRequest: { url: 'https://github.com/upstream/regional-starter/pull/7' } };
const records = [
  { type: 'CNAME', name: previewIdentity(args).hostname, value: 'example.chatgpt.site' },
  { type: 'TXT', name: '_verify.' + previewIdentity(args).hostname, value: 'site-verification-token' },
];
const env = { KEFANIA_SPACESHIP_API_KEY: 'key', KEFANIA_SPACESHIP_API_SECRET: 'secret',
  KEFANIA_SPACESHIP_ALLOWED_DOMAINS: 'example.com' };

test('fork preview includes branch and upstream repo in a stable subdomain', () => {
  const identity = previewIdentity(args);
  assert.match(identity.hostname, /^feature-login-[a-f0-9]{8}\.regional-starter\.preview\.example\.com$/);
  assert.equal(previewLabel('main'), 'main');
  assert.throws(() => previewIdentity({ ...args, headRepository: 'upstream/regional-starter' }), /upstream/);
  assert.throws(() => previewIdentity({ ...args, zone: 'example.com.evil.test/' }), /valid DNS zone/);
});

test('prepare hands a verified upstream commit to Sites without publishing', async () => {
  const flow = createPreviewActions({ actions: { context: async () => context } });
  const result = await flow.prepare(args);
  assert.equal(result.headSha, headSha);
  assert.equal(result.siteDeployed, false);
  assert.equal(result.dnsPublished, false);
  assert.match(result.sitesHandoff, /@Sites/);
  assert.match(result.sitesHandoff, new RegExp(headSha));
});

test('DNS publishing rejects missing approval, changed head, unlisted zones and foreign names', async () => {
  const flow = createPreviewActions({ actions: { context: async () => context }, env });
  const base = { ...args, expectedHeadSha: headSha, siteUrl: 'https://example.chatgpt.site/', records };
  await assert.rejects(flow.publishDns(base), /Explicit approval/);
  await assert.rejects(flow.publishDns({ ...base, approved: true, expectedHeadSha: 'b'.repeat(40) }), /changed/);
  const restricted = createPreviewActions({ actions: { context: async () => context },
    env: { ...env, KEFANIA_SPACESHIP_ALLOWED_DOMAINS: 'another.test' } });
  await assert.rejects(restricted.publishDns({ ...base, approved: true }), /explicitly listed/);
  await assert.rejects(flow.publishDns({ ...base, approved: true,
    records: [{ type: 'CNAME', name: 'www.example.com', value: 'example.chatgpt.site' }] }), /outside/);
  await assert.rejects(flow.publishDns({ ...base, approved: true, siteUrl: 'https://evil.example/' }), /chatgpt.site/);
});

test('approved publication adds only the preview CNAME and verification TXT', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    if (init.method === 'GET') return { ok: true, json: async () => ({ items: [], total: 0 }) };
    return { ok: true, status: 204 };
  };
  const flow = createPreviewActions({ actions: { context: async () => context }, env, fetchFn });
  const result = await flow.publishDns({ ...args, expectedHeadSha: headSha,
    siteUrl: 'https://example.chatgpt.site/', records, approved: true });
  assert.equal(result.dnsRecordsAdded, 2);
  assert.equal(result.publiclyReachable, 'not-verified');
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT']);
  assert.equal(calls[1].body.force, false);
  assert.equal(calls[1].body.items[0].cname, 'example.chatgpt.site');
  assert.equal(calls[1].body.items[1].value, 'site-verification-token');
});

test('existing DNS records are never overwritten', async () => {
  const identity = previewIdentity(args);
  const fetchFn = async (url, init) => {
    if (init.method !== 'GET') throw new Error('unexpected DNS write');
    return { ok: true, json: async () => ({ items: [
      { type: 'CNAME', name: identity.name, cname: 'different.example.com' },
    ], total: 1 }) };
  };
  const flow = createPreviewActions({ actions: { context: async () => context }, env, fetchFn });
  await assert.rejects(flow.publishDns({ ...args, expectedHeadSha: headSha,
    siteUrl: 'https://example.chatgpt.site/', records, approved: true }), /conflict/);
});

test('authorization errors never claim DNS publication', async () => {
  const flow = createPreviewActions({ actions: { context: async () => context }, env,
    fetchFn: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(flow.publishDns({ ...args, expectedHeadSha: headSha,
    siteUrl: 'https://example.chatgpt.site/', records, approved: true }), /HTTP 403/);
});
