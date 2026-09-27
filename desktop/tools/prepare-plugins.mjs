import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

for (const id of ['workspace', 'files', 'git']) {
  const source = fileURLToPath(new URL(`../../plugins/${id}/`, import.meta.url));
  const target = fileURLToPath(new URL(`../dist/plugins/${id}/`, import.meta.url));
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, filter: (path) => path !== join(source, 'node_modules') });
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: target, stdio: 'inherit' });
}
