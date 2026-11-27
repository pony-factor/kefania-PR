import { createHash } from 'node:crypto';

// ChatGPT Sites creation and deployment require its own ChatGPT workflow.
const domainPattern = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const shaPattern = /^[a-f0-9]{40}$/i;

function requireDomain(value) {
  const result = String(value || '').trim().toLowerCase();
  if (!domainPattern.test(result) || result.split('.').some(label => label.length > 63)) {
    throw new Error('Select a valid DNS zone such as example.com.');
  }
  return result;
}

export function previewLabel(value) {
  const original = String(value || '');
  const normalized = original.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('The repository or branch cannot form a DNS label.');
  if (normalized.length <= 63 && original === normalized) return normalized;
  const suffix = createHash('sha256').update(original).digest('hex').slice(0, 8);
  return normalized.slice(0, 54).replace(/-+$/g, '') + '-' + suffix;
}

export function previewIdentity(args) {
  const target = String(args.owner || '') + '/' + String(args.repo || '');
  const source = String(args.headRepository || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)
    || target.toLowerCase() === source.toLowerCase()) {
    throw new Error('Preview sites require a verified upstream pull request from a separate fork.');
  }
  if (!args.head || typeof args.head !== 'string') throw new Error('A published head branch is required.');
  const zone = requireDomain(args.zone);
  const namespace = previewLabel(args.namespace || 'preview');
  const name = [previewLabel(args.head), previewLabel(args.repo), namespace].join('.');
  const hostname = name + '.' + zone;
  if (hostname.length > 253) throw new Error('The preview hostname is too long.');
  return { target, source, zone, name, hostname, namespace };
}

function selection(args) {
  return { owner: args.owner, repo: args.repo, headRepository: args.headRepository,
    head: args.head, base: args.base || 'main' };
}

function cleanRecord(record, preview) {
  if (!record || !['CNAME', 'TXT'].includes(record.type)) {
    throw new Error('Only Sites-provided CNAME and TXT records are supported for preview DNS.');
  }
  const rawName = String(record.name || '').trim().toLowerCase().replace(/\.$/, '');
  const relative = rawName.endsWith('.' + preview.zone)
    ? rawName.slice(0, -preview.zone.length - 1) : rawName;
  const validName = relative === preview.name
    || (record.type === 'TXT' && /^_[a-z0-9_-]{1,62}\./.test(relative)
      && relative.slice(relative.indexOf('.') + 1) === preview.name);
  if (!validName || (record.type === 'CNAME' && relative !== preview.name)) {
    throw new Error('A record name falls outside this PR preview hostname.');
  }
  const value = String(record.value || '').trim();
  if (!value || value.length > 4096) throw new Error('DNS record values are required and limited to 4096 characters.');
  if (record.type === 'CNAME' && !domainPattern.test(value.replace(/\.$/, '').toLowerCase())) {
    throw new Error('CNAME target must be a valid hostname supplied by Sites.');
  }
  const ttl = record.ttl === undefined ? 300 : record.ttl;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new Error('DNS TTL must be 60–3600 seconds.');
  return { type: record.type, name: relative, ttl,
    ...(record.type === 'CNAME' ? { cname: value.replace(/\.$/, '').toLowerCase() } : { value }) };
}

function equalRecord(actual, proposed) {
  if (actual.type !== proposed.type) return false;
  const field = actual.type === 'CNAME' ? 'cname' : 'value';
  return actual.type === 'CNAME'
    ? String(actual[field] || '').replace(/\.$/, '').toLowerCase() === proposed[field]
    : actual[field] === proposed[field];
}

export function createPreviewActions({ actions, fetchFn = fetch, env = process.env } = {}) {
  if (!actions?.context) throw new Error('Preview sites require Kefania GitHub context verification.');
  const checked = async args => {
    const identity = previewIdentity(args);
    const context = await actions.context(selection(args));
    if (!shaPattern.test(context.headSha || '') || !context.existingPullRequest?.url) {
      throw new Error('Publish an upstream PR from the verified fork branch before preparing its preview.');
    }
    return { identity, context };
  };
  const api = async (method, zone, path, body) => {
    const key = env.KEFANIA_SPACESHIP_API_KEY;
    const secret = env.KEFANIA_SPACESHIP_API_SECRET;
    if (!key || !secret) throw new Error('Configure Spaceship API key and secret in the Kefania server environment.');
    const response = await fetchFn('https://spaceship.dev/api/v1/dns/records/' + encodeURIComponent(zone) + path, {
      method, headers: { 'X-API-Key': key, 'X-API-Secret': secret, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Spaceship DNS request failed (HTTP ' + response.status + '). No publication is confirmed.');
    return method === 'GET' ? response.json() : undefined;
  };
  const listRecords = async zone => {
    const records = [];
    for (let skip = 0; skip <= 10000; skip += 500) {
      const page = await api('GET', zone, '?take=500&skip=' + skip);
      if (!Array.isArray(page.items)) throw new Error('Spaceship DNS listing had an unexpected response.');
      records.push(...page.items);
      if ((Number.isInteger(page.total) && records.length >= page.total) || page.items.length < 500) return records;
    }
    throw new Error('DNS zone is too large to verify record conflicts safely.');
  };
  return {
    async prepare(args) {
      const { identity, context } = await checked(args);
      const sourceUrl = 'https://github.com/' + identity.source + '/tree/' + context.headSha;
      const instructions = [
        'Use @Sites in ChatGPT to create a NEW development preview website from the GitHub repository ' + identity.source + '.',
        'Use the published branch ' + args.head + ' at the exact commit ' + context.headSha + '; do not use the upstream main branch.',
        'If Sites cannot access or build this project, stop and ask for the source or build configuration rather than inventing a deployment.',
        'Save a private version for review, then ask for approval before deploying and enabling public sharing.',
        'In the Site settings, add the custom hostname ' + identity.hostname + ' and copy the exact CNAME and TXT DNS records that Sites provides.',
        'Use github_publish_preview_dns only with those exact records and separate explicit approval. Do not guess any record values.',
        'Confirm the Site is deployed and publicly shared in Sites; DNS alone does not publish a Site.',
      ].join('\n');
      return { pullRequest: context.existingPullRequest.url, sourceRepository: identity.source,
        upstreamRepository: identity.target, branch: args.head, headSha: context.headSha,
        sourceUrl, hostname: identity.hostname, sites: 'https://chatgpt.com/sites',
        sitesHandoff: instructions, siteDeployed: false, dnsPublished: false };
    },
    async publishDns(args) {
      if (args.approved !== true) throw new Error('Explicit approval to publish these DNS records is required.');
      const { identity, context } = await checked(args);
      if (!shaPattern.test(args.expectedHeadSha || '') || args.expectedHeadSha !== context.headSha) {
        throw new Error('The published PR head changed; prepare the preview again before writing DNS.');
      }
      const allowedZones = String(env.KEFANIA_SPACESHIP_ALLOWED_DOMAINS || '').split(',')
        .map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!allowedZones.includes(identity.zone)) {
        throw new Error('The DNS zone must be explicitly listed in KEFANIA_SPACESHIP_ALLOWED_DOMAINS.');
      }
      let url;
      try { url = new URL(args.siteUrl); } catch { throw new Error('Provide the real published ChatGPT Sites URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !url.hostname.endsWith('.chatgpt.site')) {
        throw new Error('Provide the real HTTPS chatgpt.site deployment URL, not a guessed target.');
      }
      if (!Array.isArray(args.records) || args.records.length < 1 || args.records.length > 10) {
        throw new Error('Copy 1–10 DNS records provided by the Site custom-domain settings.');
      }
      const records = args.records.map(record => cleanRecord(record, identity));
      if (!records.some(record => record.type === 'CNAME')) {
        throw new Error('A Sites-provided CNAME routing record is required.');
      }
      if (new Set(records.map(record => record.name.toLowerCase())).size !== records.length) {
        throw new Error('Duplicate record names need manual review before publication.');
      }
      const existing = await listRecords(identity.zone);
      const pending = [];
      for (const record of records) {
        const atName = existing.filter(item => String(item.name).toLowerCase() === record.name.toLowerCase());
        if (atName.some(item => !equalRecord(item, record))) {
          throw new Error('Existing DNS records conflict at ' + record.name + '; refusing to overwrite or force them.');
        }
        if (!atName.length) pending.push(record);
      }
      if (pending.length) await api('PUT', identity.zone, '', { force: false, items: pending });
      return { pullRequest: context.existingPullRequest.url, hostname: identity.hostname,
        siteUrl: url.href, dnsRecordsAdded: pending.length, dnsRecordsAlreadyPresent: records.length - pending.length,
        dnsWriteAccepted: true, publiclyReachable: 'not-verified',
        nextStep: 'Confirm domain verification, the deployed version, public sharing, and HTTPS reachability in ChatGPT Sites.' };
    },
  };
}
