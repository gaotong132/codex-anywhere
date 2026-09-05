import { createHash } from 'node:crypto';
import manifest from './manifest.json' with { type: 'json' };

/** Fingerprint output content, not build time or Git HEAD, so rebuilds are comparable. */
export function buildExtensionManifest(version: string, artifacts: Record<string, string | Uint8Array>) {
  const base = { ...manifest, version, version_name: `${version} dev` };
  const hash = createHash('sha256').update(JSON.stringify(base));
  for (const name of Object.keys(artifacts).sort()) {
    const value = artifacts[name];
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    hash.update(JSON.stringify([name, bytes.length])).update(bytes);
  }
  return { ...base, version_name: `${version} dev (build ${hash.digest('hex').slice(0, 8)})` };
}
