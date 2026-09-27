import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = fileURLToPath(new URL('../plugins/terminal/', import.meta.url));
const target = join(homedir(), '.local/shared/shu/plugins/terminal');
if (existsSync(target)) throw new Error(`Plugin already exists: ${target}`);
mkdirSync(resolve(target, '..'), { recursive: true });
cpSync(source, target, { recursive: true, filter: (path) => path !== join(source, 'node_modules') });
execFileSync('npm', ['ci', '--omit=dev'], { cwd: target, stdio: 'inherit' });
console.log(`Installed terminal plugin: ${target}`);
