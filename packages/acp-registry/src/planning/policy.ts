import type { AcpRegistryDistribution } from '../catalog/contracts.js';
import { invalidRegistry } from '../shared/errors.js';
import { exactKeys, inputRecord, inputString, inputUrl } from '../selection/input.js';
import type { AcpInstallPolicy } from './contracts.js';

const protectedEnvironment = /^(?:PATH|HOME|USERPROFILE|COMSPEC|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|ENV|BASH_ENV|SHELLOPTS|NODE_OPTIONS|NODE_PATH|VIRTUAL_ENV|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|LD_.*|DYLD_.*|PYTHON.*|UV_.*|NPM_CONFIG_.*|PNPM_.*|COREPACK_.*|CONDA_.*|XDG_.*)$/i;

export function installPolicy(value: unknown): AcpInstallPolicy {
  const policy = inputRecord(value, ['policy']);
  exactKeys(policy, ['network', 'allowedOrigins', 'allowInsecureHttp', 'packageScripts', 'integrity', 'reproducibility', 'allowedEnvironmentKeys'], ['policy']);
  if (!['offline', 'allow'].includes(policy.network as string) || !['deny', 'allow'].includes(policy.packageScripts as string)
    || !['require-expected-sha256', 'allow-missing-expected-sha256'].includes(policy.integrity as string)
    || !['best-effort', 'require-complete'].includes(policy.reproducibility as string) || typeof policy.allowInsecureHttp !== 'boolean') {
    invalidRegistry('acp_registry_plan_policy_invalid', ['policy'], 'Installation policies must be explicitly selected.');
  }
  if (!Array.isArray(policy.allowedOrigins) || policy.allowedOrigins.length > 128) {
    invalidRegistry('acp_registry_plan_policy_invalid', ['policy', 'allowedOrigins'], 'Allowed origins must be a bounded explicit list.');
  }
  const allowedOrigins = policy.allowedOrigins.map((origin, index) => {
    const literal = inputString(origin, ['policy', 'allowedOrigins', index], 2_048);
    let url: URL;
    try { url = new URL(literal); } catch { return invalidRegistry('acp_registry_plan_policy_invalid', ['policy', 'allowedOrigins', index], 'Expected a canonical HTTP(S) origin.'); }
    if (url.origin !== literal || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !policy.allowInsecureHttp)) {
      invalidRegistry('acp_registry_plan_policy_invalid', ['policy', 'allowedOrigins', index], 'Origins must be canonical and insecure HTTP must be explicitly permitted.');
    }
    return literal;
  });
  if (new Set(allowedOrigins).size !== allowedOrigins.length) invalidRegistry('acp_registry_plan_policy_invalid', ['policy', 'allowedOrigins'], 'Duplicate origins are unsupported.');
  if (!Array.isArray(policy.allowedEnvironmentKeys) || policy.allowedEnvironmentKeys.length > 128) {
    invalidRegistry('acp_registry_plan_environment_denied', ['policy', 'allowedEnvironmentKeys'], 'Environment keys require a bounded explicit allowlist.');
  }
  const allowedEnvironmentKeys = policy.allowedEnvironmentKeys.map((key, index) => {
    const name = inputString(key, ['policy', 'allowedEnvironmentKeys', index], 128);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || protectedEnvironment.test(name)) {
      invalidRegistry('acp_registry_plan_environment_denied', ['policy', 'allowedEnvironmentKeys', index], 'Runtime, shell, installer, and process plumbing variables are reserved.');
    }
    return name;
  });
  if (new Set(allowedEnvironmentKeys.map((key) => key.toUpperCase())).size !== allowedEnvironmentKeys.length) {
    invalidRegistry('acp_registry_plan_environment_denied', ['policy', 'allowedEnvironmentKeys'], 'Case-ambiguous environment keys are unsupported.');
  }
  return { network: policy.network as AcpInstallPolicy['network'], allowedOrigins: allowedOrigins.sort(), allowInsecureHttp: policy.allowInsecureHttp,
    packageScripts: policy.packageScripts as AcpInstallPolicy['packageScripts'], integrity: policy.integrity as AcpInstallPolicy['integrity'],
    reproducibility: policy.reproducibility as AcpInstallPolicy['reproducibility'], allowedEnvironmentKeys: allowedEnvironmentKeys.sort() };
}

export function artifactUrl(value: unknown, path: readonly (string | number)[], policy: AcpInstallPolicy): string {
  const literal = inputUrl(value, path);
  const url = new URL(literal);
  if (url.protocol === 'http:' && !policy.allowInsecureHttp) invalidRegistry('acp_registry_plan_network_denied', path, 'Insecure HTTP artifacts require explicit policy.');
  if (policy.network === 'allow' && !policy.allowedOrigins.includes(url.origin)) {
    invalidRegistry('acp_registry_plan_network_denied', path, 'The artifact origin is not permitted by this installation plan.');
  }
  return literal;
}

export function validateLaunchEnvironment(distribution: AcpRegistryDistribution, policy: AcpInstallPolicy): void {
  const folded = new Set<string>();
  for (const key of Object.keys(distribution.env)) {
    if (folded.has(key.toUpperCase()) || protectedEnvironment.test(key) || !policy.allowedEnvironmentKeys.includes(key)) {
      invalidRegistry('acp_registry_plan_environment_denied', ['distribution', 'env', key], 'Catalog launch environment is outside the explicit permitted key policy.');
    }
    folded.add(key.toUpperCase());
  }
}
