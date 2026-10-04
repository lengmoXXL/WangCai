import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// One app per architecture. The agent inside it, the node it builds plugins with and the app itself
// all have to be that architecture, and electron-builder only packages what it is handed, so each of
// the three is built for the architecture being packaged here.
const arch = process.argv[2];
const target = { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' }[arch];
if (!target) throw new Error('Usage: node tools/package-mac.mjs x64|arm64');

const root = fileURLToPath(new URL('../..', import.meta.url));
const desktop = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

run('npm', ['run', 'build:sdk'], root);
run('npm', ['run', 'typecheck:app'], root);
run('cargo', ['build', '--release', '--target', target, '--manifest-path', 'wangcaicli/Cargo.toml'], root);
// electron-builder takes the agent from one path, whichever architecture it was built for.
const agent = join(root, 'wangcaicli/dist/release/wangcai');
mkdirSync(dirname(agent), { recursive: true });
cpSync(join(root, 'wangcaicli/dist', target, 'release/wangcai'), agent);
run('node', ['tools/fetch-node.mjs', arch], desktop);
run('node', ['tools/build-plugins.mjs'], desktop);
run('npx', ['electron-vite', 'build'], desktop);
run('npx', ['electron-builder', '--mac', 'dmg', 'zip', `--${arch}`], desktop);
