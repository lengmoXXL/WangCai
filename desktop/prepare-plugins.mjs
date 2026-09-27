import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = fileURLToPath(new URL('../plugins/terminal/', import.meta.url));
const target = fileURLToPath(new URL('./dist/plugins/terminal/', import.meta.url));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, filter: (path) => path !== join(source, 'node_modules') });
execFileSync('npm', ['ci', '--omit=dev'], { cwd: target, stdio: 'inherit' });
