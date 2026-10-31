# 发布流程

一次发布涉及三样东西，去处各不相同：

| 发的东西 | 版本取哪儿 | 怎么出去 |
| --- | --- | --- |
| App（本仓库的壳） | `desktop/package.json` 的 `version` | 推 `v<version>` tag，pipeline 在 `macos-latest` 上打 x64 与 arm64 的 dmg、zip，传进同名 GitHub release，并标成 latest |
| agent（`wangcaicli`，机器上跑的 `wangcai` 节点） | `wangcaicli/Cargo.toml` 的 `version` | pipeline 按 `agent-v<version>` 建独立 release，只放二进制与 `.sha256`，不是 latest |
| Core（[WangCai-Core](https://github.com/lengmoXXL/WangCai-Core)） | 仓库本身，没有版本号 | 不进这个 release：把它推到 main，用户端的「更新」会 clone 并重建 |

`workflow_dispatch` 也会跑 `app` 作业把包打出来，只是不会传进 release：那次只把包留成 workflow 的 artifact。

`app` 作业的两支都校验：

- 两个二进制（`Contents/MacOS/旺财`、`Contents/Resources/node/bin/node`）的架构必须是这次打的架构，用 `lipo -archs` 读；
- 包里不能带 Core（启动时由壳自己装）。

arm64 那一支还会先 `git clone` 一份 Core 并构建，交给自己那条打包校验（`node --test tests/package.cjs`），让打包出来的 app 真启动、按 `init.ts` 装插件。

## 发一版 App

1. **先把 Core 推上去。** 上面那份 Core 来自默认分支：Core 没推，验的就是旧的。
2. **本地跑一遍。** `npm test`（构建 + `tests/*.test.cjs`；构建那步已带 sdk 与壳的类型检查）。
3. **升版本并提交。** 改 `desktop/package.json` 的 `version`，提交 `chore: release <version>`。pipeline 只认这个字段：tag 名与它不一致会直接失败。
4. **打 tag 并推。**

   ```sh
   git tag v<version>
   git push origin main
   git push origin v<version>
   ```

5. **看 run。** `gh run list` 里出现 `release … v<version>`。
6. **核对 release。** latest 应指向它，变更说明由 `--generate-notes` 自动生成，资产四个：`wangcai-<version>-arm64.dmg`、`-arm64.zip`、`-x64.dmg`、`-x64.zip`。

## 什么时候发 agent

`versions` 作业的判据是「`wangcaicli` 相对上一个 `v*` tag 有没有变化」：

- 有变化：要求 `wangcaicli/Cargo.toml` 的版本也变过，然后推 `agent-v<version>` 的三个 target（`x86_64`/`aarch64` 的 macOS、`x86_64-unknown-linux-musl`）。
- 没变化：要求 `agent-v<version>` 已经存在（Core 钉住的就是这个版本），这次不重发。

要绕过判据、对同一个 checkout 强制重发，用 `workflow_dispatch` 并勾 `agent=true`。

如果 `wangcaicli` 的改动发生在某个 `v*` tag 之后、并且已经单独发过 agent，那么下一个 App tag 仍会判定「要发 agent」，把同一个版本重传一次（`gh release upload --clobber`）。版本号不变，但二进制是重新构建的，旧文件与旧 `.sha256` 都被覆盖、不留档；代价是多跑一遍三平台的构建。`v0.1.23` 就是这样。

## 本地打包

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run package` | `desktop/dist/package/mac*/旺财.app`（`--mac dir`，目录名随宿主架构） | 本机启动看效果；ad-hoc 签名，未公证 |
| `npm run package:mac:x64` / `npm run package:mac:arm64` | `desktop/dist/package/*.dmg`、`*.zip` | 要分架构的 dmg、zip 时用（与 pipeline 同一条命令）；本地验效果用上一行 |
| `npm run test:package` | `--mac dir` 那个 `旺财.app` | 发布前在本地验一遍：打包出来的 app 能启动、按 `init.ts` 装插件 |

Developer ID 签名与公证都不在 pipeline 里：日志会出现 `identityName=-`、`skipped macOS notarization`；要发签名版得在打包机上给 electron-builder 提供证书。

## 补救

| 情况 | 做法 |
| --- | --- |
| 某个资产传坏了 | `gh release upload v<version> <文件> --clobber`，或在 Actions 里重跑那次 run |
| 打包失败、tag 已推 | 修好代码后再推一个新 tag；不要把同一个 tag 挪到别的提交上——挪了之后，已发布的资产和 tag 指向的代码就对不上 |
