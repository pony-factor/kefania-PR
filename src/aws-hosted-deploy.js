import { spawn } from 'node:child_process';

const repositoryUrl = 'https://github.com/pony-factor/kefania-PR';
const pendingUrl = 'https://kefania-pending.invalid';
const regionPattern = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const appRunnerService = /^arn:aws[a-z-]*:apprunner:[\w-]+:\d{12}:service\/[\w-]+\/[\w-]+$/;
const required = (value, pattern, label) => {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!pattern.test(clean)) throw new Error('Invalid ' + label + '.');
  return clean;
};
const list = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean);
const https = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }
  catch { return false; }
};

export function deploymentSpec(input) {
  const region = required(input?.region, regionPattern, 'AWS region');
  const serviceName = required(input?.serviceName, /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/, 'service name');
  const connection = required(input?.connectionArn, /^arn:aws[a-z-]*:apprunner:[\w-]+:\d{12}:connection\/[\w-]+\/[\w-]+$/, 'GitHub connection ARN');
  const role = required(input?.instanceRoleArn, /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/, 'instance IAM role ARN');
  const secretPattern = /^arn:aws[a-z-]*:secretsmanager:[\w-]+:\d{12}:secret:[\w/+=.@-]+$/;
  const secret = required(input?.clientSecretArn, secretPattern, 'GitHub client secret ARN');
  const key = required(input?.privateKeyArn, secretPattern, 'GitHub PEM secret ARN');
  if ([connection, secret, key].some(value => !value.includes(':' + region + ':'))) {
    throw new Error('Connection and secrets must use the selected AWS region.');
  }
  const client = required(input?.clientId, /^[a-zA-Z0-9_-]{8,100}$/, 'GitHub client ID');
  const app = required(input?.appId, /^\d+$/, 'GitHub App ID');
  const users = list(input?.userIds), repos = list(input?.repositories), redirects = list(input?.redirects);
  if (!users.length || users.some(v => !/^\d+$/.test(v))) throw new Error('Enter numeric GitHub user IDs.');
  if (!repos.length || repos.some(v => !repoPattern.test(v))) throw new Error('Enter owner/repo names.');
  if (!redirects.length || redirects.some(v => !https(v))) throw new Error('Enter exact HTTPS OAuth redirect URIs.');
  return { region, spec: {
    ServiceName: serviceName,
    SourceConfiguration: {
      AuthenticationConfiguration: { ConnectionArn: connection },
      AutoDeploymentsEnabled: true,
      CodeRepository: {
        RepositoryUrl: repositoryUrl, SourceCodeVersion: { Type: 'BRANCH', Value: 'main' },
        CodeConfiguration: { ConfigurationSource: 'API', CodeConfigurationValues: {
          Runtime: 'NODEJS_22', BuildCommand: 'npm ci --omit=dev --ignore-scripts',
          StartCommand: 'npm run start:hosted', Port: '8765',
          RuntimeEnvironmentVariables: {
            KEFANIA_PUBLIC_URL: pendingUrl, KEFANIA_GITHUB_CLIENT_ID: client,
            KEFANIA_GITHUB_APP_ID: app, KEFANIA_ALLOWED_USER_IDS: users.join(','),
            KEFANIA_ALLOWED_REPOSITORIES: repos.join(','),
            KEFANIA_OAUTH_REDIRECT_URIS: redirects.join(','),
          },
          RuntimeEnvironmentSecrets: {
            KEFANIA_GITHUB_CLIENT_SECRET: secret, KEFANIA_GITHUB_PRIVATE_KEY: key,
          },
        } },
      },
    },
    InstanceConfiguration: { Cpu: '0.25 vCPU', Memory: '0.5 GB', InstanceRoleArn: role },
    HealthCheckConfiguration: { Protocol: 'HTTP', Path: '/health' },
  } };
}

export function runAws(args, body) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', [...args, '--no-cli-pager', '--output', 'json'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', count = 0, settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      return error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill(); done(new Error('AWS timed out. Inspect App Runner before retrying.'));
    }, 60000);
    child.stdout.on('data', chunk => {
      count += chunk.length;
      if (count > 1024 * 1024) {
        child.kill(); done(new Error('AWS response too large.'));
      } else output += chunk;
    });
    // Deliberately do not expose AWS stderr or the credential provider to the UI.
    child.stderr.on('data', () => {});
    child.on('error', () => done(new Error('AWS CLI is missing or not executable.')));
    child.on('close', code => {
      if (code !== 0) return done(new Error('AWS operation failed. Check AWS credentials, roles, connection and service status.'));
      try { done(null, JSON.parse(output)); }
      catch { done(new Error('AWS returned an invalid JSON response.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function hostedDeployment({ run = runAws } = {}) {
  return {
    async deploy(input) {
      const { region, spec } = deploymentSpec(input);
      const result = await run(['apprunner', 'create-service', '--region', region,
        '--cli-input-json', 'file:///dev/stdin'], spec);
      const arn = result.Service?.ServiceArn;
      if (!appRunnerService.test(arn || '')) {
        throw new Error('Service creation returned an unexpected response. Check AWS before retrying.');
      }
      return { region, serviceArn: arn, status: result.Service?.Status, needsActivation: true };
    },
    async activate(input) {
      const region = required(input?.region, regionPattern, 'AWS region');
      const arn = required(input?.serviceArn, appRunnerService, 'service ARN');
      if (!arn.includes(':' + region + ':')) throw new Error('Service region mismatch.');
      const current = (await run(['apprunner', 'describe-service', '--region', region,
        '--service-arn', arn])).Service;
      if (!current || current.ServiceArn !== arn ||
        current.SourceConfiguration?.CodeRepository?.RepositoryUrl !== repositoryUrl) {
        throw new Error('That is not a Kefania service.');
      }
      if (current.Status !== 'RUNNING') throw new Error('AWS service is not RUNNING yet. Activate after deployment finishes.');
      const host = current.ServiceUrl;
      if (!/^[a-z0-9.-]+\.awsapprunner\.com$/.test(host || '')) throw new Error('Invalid AWS service hostname.');
      const publicUrl = 'https://' + host;
      const source = current.SourceConfiguration;
      const code = source.CodeRepository.CodeConfiguration;
      const values = code.CodeConfigurationValues;
      if (!values?.RuntimeEnvironmentSecrets?.KEFANIA_GITHUB_PRIVATE_KEY) throw new Error('Missing bot secret references.');
      const change = { ServiceArn: arn, SourceConfiguration: {
        ...source, CodeRepository: { ...source.CodeRepository,
          CodeConfiguration: { ...code, CodeConfigurationValues: {
            ...values, RuntimeEnvironmentVariables: {
              ...values.RuntimeEnvironmentVariables, KEFANIA_PUBLIC_URL: publicUrl,
            },
          } },
        },
      } };
      await run(['apprunner', 'update-service', '--region', region,
        '--cli-input-json', 'file:///dev/stdin'], change);
      return { mcpUrl: publicUrl + '/mcp', callbackUrl: publicUrl + '/oauth/github/callback',
        status: 'UPDATING' };
    },
  };
}
