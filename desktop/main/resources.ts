import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = ['docs', 'sdk', 'examples', 'README.md', 'desktop/main', 'desktop/ui', 'desktop/shared.ts', 'desktop/build/icon.png'];

// These are the app's files, not the user's: a new version replaces the snapshot an agent reads.
export function syncSources(shipped: string, storage: string, version: string) {
  const directory = join(storage, 'src');
  const stamp = join(storage, 'src.version');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return;
  rmSync(directory, { recursive: true, force: true });
  for (const entry of SOURCES) cpSync(join(shipped, entry), join(directory, entry), { recursive: true });
  writeFileSync(stamp, version);
}
