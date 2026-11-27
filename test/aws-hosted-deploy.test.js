import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentSpec, hostedDeployment } from '../src/aws-hosted-deploy.js';

const input = {
  region: 'us-east-1', serviceName: 'kefania-web',
  connectionArn: 'arn:aws:apprunner:us-east-1:123456789012:connection/registered/abcdef012345',
  instanceRoleArn: 'arn:aws:iam::123456789012:role/HostedSecrets',
  clientSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:oauth-Abc1',
  privateKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:private-Abc1',
  clientId: 'Iv23lisSpJKeF3M3eu30', appId: '4871148', userIds: '123',
  repositories: 'pony-factor/kefania-PR',
  redirects: 'https://chatgpt.com/connector_platform_oauth_redirect',
};
const serviceArn = 'arn:aws:apprunner:us-east-1:123456789012:service/kefania-web/abcd1234';

test('deployment requires secret references, approved identities and HTTPS callbacks', () => {
  const result = deploymentSpec(input);
  const values = result.spec.SourceConfiguration.CodeRepository.CodeConfiguration.CodeConfigurationValues;
  assert.equal(values.StartCommand, 'npm run start:hosted');
  assert.equal(values.Runtime, 'NODEJS_22');
  assert.equal(values.RuntimeEnvironmentSecrets.KEFANIA_GITHUB_PRIVATE_KEY, input.privateKeyArn);
  for (const bad of [{ region: 'not-a-region' }, { privateKeyArn: 'private key content' },
    { repositories: '../../secrets' }, { userIds: 'bad' }, { redirects: 'http://localhost' }]) {
    assert.throws(() => deploymentSpec({ ...input, ...bad }));
  }
});
test('created deployment is activated with its own AWS hostname, preserving secret references', async () => {
  const calls = [];
  const config = deploymentSpec(input).spec.SourceConfiguration;
  const runner = async (args, body) => {
    calls.push({ args, body });
    if (args.includes('create-service')) return { Service: { ServiceArn: serviceArn } };
    if (args.includes('describe-service')) return { Service: { ServiceArn: serviceArn,
      Status: 'RUNNING', ServiceUrl: 'abc.us-east-1.awsapprunner.com', SourceConfiguration: config } };
    return {};
  };
  const service = hostedDeployment({ run: runner });
  assert.equal((await service.deploy(input)).needsActivation, true);
  const activated = await service.activate({ region: 'us-east-1', serviceArn });
  assert.match(activated.mcpUrl, /^https:\/\//);
  const code = calls[2].body.SourceConfiguration.CodeRepository.CodeConfiguration.CodeConfigurationValues;
  assert.equal(code.RuntimeEnvironmentVariables.KEFANIA_PUBLIC_URL, 'https://abc.us-east-1.awsapprunner.com');
  assert.equal(code.RuntimeEnvironmentSecrets.KEFANIA_GITHUB_PRIVATE_KEY, input.privateKeyArn);
});
test('activation rejects unrelated apps without updating them', async () => {
  let calls = 0;
  const service = hostedDeployment({ run: async () => { calls++; return { Service: {
    ServiceArn: serviceArn, Status: 'RUNNING', ServiceUrl: 'abc.us-east-1.awsapprunner.com',
    SourceConfiguration: { CodeRepository: { RepositoryUrl: 'https://github.com/other/repo' } },
  } }; } });
  await assert.rejects(service.activate({ region: 'us-east-1', serviceArn }), /not a Kefania/);
  assert.equal(calls, 1);
});
