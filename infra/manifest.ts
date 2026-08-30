import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

type ManifestEnvironment = {
  account?: string;
  region?: string;
};

type Manifest = ManifestEnvironment;

function expandEnvironmentVariables(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '');
}

function resolveValue(value: string | undefined, fallback: string | undefined): string | undefined {
  if (!value) {
    return fallback;
  }
  const expanded = expandEnvironmentVariables(value);
  return expanded || fallback;
}

export function loadManifestEnvironment(): ManifestEnvironment {
  const manifestPath = resolve(process.cwd(), 'manifest.yml');
  const manifest = parse(readFileSync(manifestPath, 'utf8')) as Manifest | null;

  if (!manifest) {
    throw new Error(
      `${manifestPath} must define the target AWS account and region.`,
    );
  }

  return {
    account: resolveValue(manifest.account, process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID),
    region: resolveValue(
      manifest.region,
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
    ),
  };
}