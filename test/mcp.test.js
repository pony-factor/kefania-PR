import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/http.js';
import { createActions } from '../src/pull-requests.js';

test('stdio handshake, tool discovery, and canonical instructions', async () => {
  const client = new Client({ name: 'kefania-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/index.js'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'codex-drafter');
    const { tools } = await client.listTools();
    for (const name of ['github_get_pull_request_context', 'github_create_pull_request', 'github_register_pull_request_stack', 'github_comment_pull_request_source', 'github_create_issue']) {
      assert(tools.some(tool => tool.name === name));
    }
    const rules = await client.callTool({ name: 'kefania_drafting_rules', arguments: {} });
    assert.equal(rules.isError, undefined);
    assert.match(rules.content[0].text, /Draft from the repository evidence/);
    assert.match(rules.content[0].text, /Weave GitHub backreferences into the narrative/);
    const invalid = await client.callTool({ name: 'github_comment_pull_request_source', arguments: {
      owner: 'pony-factor', repo: 'kefania', head: 'branch', source: {
        kind: 'chatgpt', uuid: '11111111-2222-4333-8444-555555555555', url: 'https://example.com/not-the-conversation',
      },
    } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

test('HTTP requires authentication and accepts real MCP requests', async () => {
  const token = 'test-only-not-a-real-credential-123456';
  const app = createHttpApp({ token, actions: createActions({ request: async () => ({ login: 'fixture-user' }) }) });
  const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const url = new URL(`http://127.0.0.1:${listener.address().port}/mcp`);
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const status = await client.callTool({ name: 'kefania_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).githubLogin, 'fixture-user');
  } finally {
    await client.close();
    await new Promise(resolve => listener.close(resolve));
  }
});

test('HTTP cannot start with missing authentication or unrestricted public host', () => {
  assert.throws(() => createHttpApp({}), /requires/);
  assert.throws(() => createHttpApp({ token: 'test-only-not-a-real-credential-123456', host: '0.0.0.0' }), /ALLOWED_HOSTS/);
});
