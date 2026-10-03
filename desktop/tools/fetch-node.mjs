import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A plugin builds by running the build script of its own repository, so the app carries the node and npm
// that run it: the user's toolchain is not involved, and the version a plugin sees never changes under it.
const VERSION = 'v22.23.3';
const directory = fileURLToPath(new URL('../node/', import.meta.url));

if (existsSync(join(directory, 'bin/node'))) {
  console.log(`node ${VERSION} is already there: ${directory}`);
} else {
  const name = `node-${VERSION}-darwin-${process.arch}`;
  const archive = join(directory, `${name}.tar.gz`);
  mkdirSync(directory, { recursive: true });
  console.log(`downloading ${name}…`);
  const response = await fetch(`https://nodejs.org/dist/${VERSION}/${name}.tar.gz`);
  if (!response.ok) throw new Error(`Cannot download ${name}: ${response.status}`);
  await pipeline(response.body, createWriteStream(archive));
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', directory]);
  rmSync(archive);
  // Documentation and headers take a third of the download and nothing here reads them.
  for (const entry of ['include', 'share', 'CHANGELOG.md', 'README.md']) rmSync(join(directory, entry), { recursive: true, force: true });
  console.log(`node ${VERSION} at ${directory}`);
}
