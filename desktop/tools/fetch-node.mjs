import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A plugin builds by running the build script of its own repository, so the app carries the node and npm
// that run it: the user's toolchain is not involved, and the version a plugin sees never changes under it.
const VERSION = 'v22.23.3';
const arch = process.argv[2] ?? process.arch;
const directory = fileURLToPath(new URL('../node/', import.meta.url));
const stamp = join(directory, 'arch');

if (existsSync(join(directory, 'bin/node')) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === arch) {
  console.log(`node ${VERSION} for ${arch} is already there: ${directory}`);
} else {
  rmSync(directory, { recursive: true, force: true });
  const name = `node-${VERSION}-darwin-${arch}`;
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
  writeFileSync(stamp, arch);
  console.log(`node ${VERSION} for ${arch} at ${directory}`);
}
