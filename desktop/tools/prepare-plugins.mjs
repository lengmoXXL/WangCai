import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildPlugin, isPluginBuildCurrent } from '../main/plugin-build.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

for (const id of ['workspace', 'files', 'git', 'terminal']) {
  const source = fileURLToPath(new URL(`../../plugins/${id}/`, import.meta.url));
  const target = fileURLToPath(new URL(`../dist/plugins/${id}/`, import.meta.url));
  const install = !existsSync(join(target, 'node_modules')) || ['package.json', 'package-lock.json'].some((file) =>
    !existsSync(join(target, file)) || !readFileSync(join(source, file)).equals(readFileSync(join(target, file))));
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(target)) {
    if (entry !== 'node_modules' && entry !== '.compiled') rmSync(join(target, entry), { recursive: true, force: true });
  }
  cpSync(source, target, { recursive: true, filter: (path) => path !== join(source, 'node_modules') });
  if (install) {
    try { execFileSync('npm', ['ci', '--omit=dev'], { cwd: target, stdio: 'inherit' }); }
    catch (error) { rmSync(join(target, 'node_modules'), { recursive: true, force: true }); throw error; }
  }
  const output = join(target, '.compiled');
  const dependencies = join(target, 'node_modules');
  if (!isPluginBuildCurrent(target, output, version, dependencies)) await buildPlugin(target, output, version, dependencies);
}
