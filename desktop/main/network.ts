import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Network } from '@lengmoxxl/sdk/bridge';

const trimmed = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function networkOf(value: unknown): Network {
  const input = (value ?? {}) as Record<string, unknown>;
  const proxy = trimmed(input.proxy);
  const mirror = trimmed(input.mirror);
  return {
    // curl reads a bare socks:// as SOCKS4, and npm needs a scheme.
    proxy: proxy && (/^\w+:\/\//.test(proxy) ? proxy : `http://${proxy}`).replace(/^socks:\/\//, 'socks5://'),
    mirror: mirror && (mirror.endsWith('/') ? mirror : `${mirror}/`),
  };
}

// Core may need to be fetched before it can load the configuration itself.
export async function bootstrapNetwork(directory: string): Promise<Network> {
  const source = join(directory, 'init.ts');
  if (!existsSync(source)) return {};
  try {
    const { default: input } = await import(pathToFileURL(source).href) as { default?: { network?: unknown } };
    return networkOf(input?.network);
  } catch {
    return {};
  }
}
