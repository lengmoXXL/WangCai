import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import esbuildPackage from 'esbuild/package.json' with { type: 'json' };

/** @type {import('esbuild').BuildOptions} */
const mainOptions = {
  bundle: true, platform: 'node', target: 'node22', sourcemap: 'linked', external: ['@wangcai/sdk'],
  supported: { 'dynamic-import': false },
};
/** @type {import('esbuild').BuildOptions} */
const uiOptions = {
  bundle: true, format: 'esm', target: 'chrome140', jsx: 'automatic', sourcemap: 'linked',
  loader: { '.ttf': 'file' }, define: { 'process.env.NODE_ENV': '"production"' },
};
const compilerVersion = JSON.stringify({ format: 1, esbuildVersion: esbuildPackage.version, mainOptions, uiOptions });

/** @param {string} source */
function sourceHash(source) {
  const hash = createHash('sha256');
  /** @param {string} directory */
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.compiled' || entry.name.startsWith('.build-')) continue;
      const path = join(directory, entry.name);
      hash.update(relative(source, path)).update('\0');
      if (entry.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (entry.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
      hash.update('\0');
    }
  }
  visit(source);
  return hash.digest('hex');
}

/** @param {string} source @param {string} dependencies @param {string} path */
function inputPath(source, dependencies, path) {
  if (!path.startsWith(`node_modules${sep}`)) return resolve(source, path);
  const parts = path.split(sep).slice(1);
  const name = parts[0].startsWith('@') ? join(parts[0], parts[1]) : parts[0];
  return existsSync(join(source, 'node_modules', name)) ? join(source, path) : join(dependencies, ...parts);
}

/** @param {string} source @param {string} output @param {string} appVersion @param {string} dependencies */
export function isPluginBuildCurrent(source, output, appVersion, dependencies) {
  try {
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    if (manifest.compiler !== compilerVersion || manifest.app !== appVersion || manifest.source !== sourceHash(source)) return false;
    for (const [path, hash] of Object.entries(manifest.inputs)) {
      if (createHash('sha256').update(readFileSync(inputPath(source, dependencies, path))).digest('hex') !== hash) return false;
    }
    return manifest.outputs.every((/** @type {string} */ path) => existsSync(join(output, path)));
  } catch { return false; }
}

/** @param {string} source @param {string} output @param {string} appVersion @param {string} dependencies */
export async function buildPlugin(source, output, appVersion, dependencies) {
  const { build } = await import('esbuild');
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), '.build-'));
  try {
    const sourceDigest = sourceHash(source);
    const main = await build({
      ...mainOptions,
      absWorkingDir: source, nodePaths: [dependencies], metafile: true,
      entryPoints: ['main.ts'], outfile: join(staging, 'main.cjs'),
    });
    const results = [main];
    if (existsSync(join(source, 'ui.tsx'))) {
      results.push(await build({
        ...uiOptions,
        absWorkingDir: source, nodePaths: [dependencies], metafile: true,
        entryPoints: ['ui.tsx', ...(existsSync(join(source, 'ui.worker.ts')) ? ['ui.worker.ts'] : [])], outdir: staging,
        plugins: [{ name: 'node-sdk-boundary', setup(builder) {
          builder.onResolve({ filter: /^@wangcai\/sdk$/ }, () => ({ errors: [{ text: '@wangcai/sdk is only available in main.ts' }] }));
        } }],
      }));
    }
    const inputs = new Set(results.flatMap((result) => Object.keys(result.metafile.inputs).map((path) => resolve(source, path))));
    for (const path of [...inputs]) {
      for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
        if (existsSync(join(directory, 'package.json'))) { inputs.add(join(directory, 'package.json')); break; }
      }
    }
    const manifest = {
      compiler: compilerVersion, app: appVersion, source: sourceDigest,
      inputs: Object.fromEntries([...inputs].map((path) => {
        const local = relative(dependencies, path);
        const key = !local.startsWith(`..${sep}`) && local !== '..' ? join('node_modules', local) : relative(source, path);
        return [key, createHash('sha256').update(readFileSync(path)).digest('hex')];
      })),
      outputs: results.flatMap((result) => Object.keys(result.metafile.outputs).map((path) => relative(staging, resolve(source, path)))),
    };
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest));
    rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
