# @lengmoxxl/sdk
The client SDK for [WangCai](https://github.com/lengmoXXL/WangCai), the terminal app. It reaches a machine, the one
the app runs on or one over SSH, and drives its terminals, files and subprocesses through a single connection.

A WangCai plugin compiles against this package for the types it uses; the machines belong to the app, which keeps
one connection per machine and hands it to every plugin that asks for one.

## Install

```
npm install @lengmoxxl/sdk
```

`ws` is the only runtime dependency. The bundled `dist/index.cjs` reads it at require time.

## Use

```ts
import { openMachine } from '@lengmoxxl/sdk';

const connection = await openMachine({ type: 'local', binary: '/path/to/wangcai' });

const sessions = await connection.pty.list();
const session = await connection.pty.create({ rows: 24, cols: 80 }, '/repo');
const terminal = await connection.pty.attach(session.id);
terminal.onData(({ data }) => process.stdout.write(data));
await terminal.write('git status\n');

const { stdout } = await connection.subprocess.exec('git', ['status'], { cwd: '/repo' });
connection.disconnect();
```

`openMachine` returns a `MachineConnection`; every call opens its own. Sharing one belongs to the caller: a
connection is reference counted, so callers that hand the same one around keep it alive until the last
`disconnect()`. `openMachine({ type: 'ssh', host, agent })` installs the carrier agent on the host first when
`agent` is given.

- `connection.pty` - `list`, `cwd`, `create`, `attach`, `close`
- `connection.fs` - `stat`, `readDirectory`, `readFile`
- `connection.subprocess` - `exec`, which returns `{ stdout, stderr, code }` as `Uint8Array`
- `connection.onState` - connection status and the sessions it can see

The host-side context a plugin is activated with (`MainContext`, `UiContext`, `Bus`, and the workspace protocol
types) lives in the `@lengmoxxl/sdk/channel` entry. That entry is types only.

## Build

```
npm run build
```

From the repository root (the TypeScript and esbuild devDependencies live in the workspace root): esbuild bundles
`index.ts` into `dist/index.cjs` with `ws` left external, then `tsc` emits the declarations. `npm publish` and
`npm pack` run it for you.
