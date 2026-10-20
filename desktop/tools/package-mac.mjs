import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One app per architecture. The node it builds plugins with and the app itself have to be that
// architecture, and electron-builder only packages what it is handed, so each of the two is built for the
// architecture being packaged here. The agent a machine runs is not part of the app: Core installs it.
const arch = process.argv[2];
if (arch !== 'x64' && arch !== 'arm64') throw new Error('Usage: node tools/package-mac.mjs x64|arm64');

const root = fileURLToPath(new URL('../..', import.meta.url));
const desktop = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

run('npm', ['run', 'build:sdk'], root);
run('npm', ['run', 'typecheck:app'], root);
run('node', ['tools/fetch-node.mjs', arch], desktop);
run('npx', ['electron-vite', 'build'], desktop);
run('npx', ['electron-builder', '--mac', 'dmg', 'zip', `--${arch}`], desktop);