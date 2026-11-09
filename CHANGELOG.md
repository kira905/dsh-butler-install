# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.3.33] - 2026-11-09

> 一句话：engine 再抬一格到 `^0.5.4`（0.5.3 的发布物里还剩一行私有脚本路径，解包扫才抓到，0.5.4 补掉）。
> **安装器逻辑仍是一处未改，只跟版本 + 重建 exe。**

### 清单变更

- `@kira905/dsh-butler-engine` `^0.5.3` → `^0.5.4`。

### 为什么

- 0.5.3 的 tarball **解包后**逐文件扫出 `jobs/lib/entities.mjs` 注释里一条私有临时目录路径。仓内扫描抓不到、
  `npm view` 更抓不到 —— 判据必须是「解开再 grep」。0.5.4 只清这一行，判定逻辑零变化。
- 下界严格跟着 npm 实体走（闸④ 判据 = 清单下界 == npm latest），所以 0.5.3 → 0.5.4 这一步必须同步抬清单，
  否则装出来的机器会停在带遗漏的那一版。

## [0.3.32] - 2026-11-09

> 一句话：引擎补两个「干净机器上装完就坏」的作业缺陷（`reconcile` 包内缺件 / `hot` 假设作者机器的
> 私有备份树存在），清单下界跟着上抬。**安装器自身逻辑一处未改，只跟版本。**

### 清单变更

- `@kira905/dsh-butler-engine` `^0.5.2` → `^0.5.3`。

### 为什么

- 干净新机器上，`jobs/butler-reconcile.mjs` 必抛 `ERR_MODULE_NOT_FOUND`（它 import 的
  `jobs/lib/reconcile.mjs` 从来没进过发布包），`hot` 必报 `repo-missing` 并**退出 1**
  （它假设 `~/dsh-git-backup/dsh-workspace` 存在，而那是作者机器的布局，且**报错里不告诉人该设哪个变量**）。
  两条都是 A-8 关 3「一条作业真跑起来」现跑抓到的。
- 0.5.3 修完后同一条 `--once` 在隔离环境里：`reconcile` 与 `hot` 双双 `ok / exit 0 / runs 1`，
  产物落盘**非空**且 mtime 是当次（读数见交付报告）。
- `npm-latest-snapshot.json` 已按真网络刷新（19 项）。

## [0.3.31] - 2026-11-09

> 一句话：三个 CLI 包各发一个 patch，把**发布物**里的私有痕迹（私有工具路径 / 私有授权细则档名 /
> 两个渠道品牌词 / 内部组件名）清干净；清单下界跟着上抬。

### 清单变更

- `@kira905/dsh-nurse` `^0.1.1` → `^0.1.2`
- `@kira905/dsh-diagnostics-extra` `^0.1.2` → `^0.1.3`
- `@kira905/dsh-board-toolkit` `^0.1.3` → `^0.1.4`

三包都只动注释 / 说明字符串；`dsh-diagnostics-extra` 的 `REDLINE` 另去掉两个渠道品牌词
（内部通知通道名 + 一个 IM 平台名），那是启发式判档面的变化 —— 这两个词不再单独被判成红线，
其余词与整条启发式都保留，误判代价仍是清单多一行标注，不是决策。**无功能变更。**
`npm-latest-snapshot.json` 已按真网络刷新（19 项）。

## [0.3.30] - 2026-11-09

> 一句话：**0.3.28 那条「已知阻断」解除** —— 看板 1.2.1 修掉了客户端按裸名 require 适配层，
> 只装注册表版清单的桌面 profile 装完不会再报 `web boot: 1 entry did not activate`。

### 清单变更

- `@kira905/dsh-task-board-local` 下界 `^1.2.0` → `^1.2.1`。1.2.0 的 `lib/client.js` 用私有树的
  **裸名** `dsh-host-adapter-client` 去 require 适配层，而注册表装来的
  `@kira905/dsh-host-adapter-client` 注册 id 带 scope ⇒ 宿主注入的 `require` 按 id 查 ⇒ 同步
  require MISS ⇒ 整个 client entry 挂不上、宿主报 `web boot: 1 entry did not activate`、**桌面版
  直接起不来**（剔除看板后一切正常）。1.2.1 主路改成 scoped 注册 id、裸名降为 `try` 内 fallback
  （老 profile 里那份本地件仍是不带 scope 的名字，两边都认）；`dsh.client.external` 与构建的
  `CLIENT_EXTERNALS` 同步声明两个名字。
  ⚠️ 1.2.0 别往回降（注册表环境下桌面版起不来）。

### 已解除的阻断

- 0.3.28「已知阻断」那一条已修，见上。

## [0.3.29] - 2026-11-09

> 一句话：**生态面板卡片宽度 780 → 680px**（窗口约 900px 时两侧留白太少，看着像贴着窗口撑满）。
> 纯 UI 值调整，不动任何判定逻辑；主人 2026-11-09 08:30 当面定的值。

### 清单变更

- `@kira905/dsh-ecosystem-panel` 下界 `^0.5.5` → `^0.5.6`。

## [0.3.28] - 2026-11-09

> 一句话：**修 A-8 关 4（载体与指引）** —— 桌面版装完终于能看见管家面板；
> 面板/生态面板自己会写"缺哪个模块 / 该改哪个文件 / 改完怎么验证"。

### 清单变更

- `@kira905/dsh-host-adapter-client` **下界 `^0.1.2` → `^0.2.0`，`mount` 从 `manual` 改 `auto`。**
  0.2.0 起它自带 `dsh.bundle.patch`，装进 profile 就被宿主自己挂上；0.1.x 靠
  `dsh-host-adapter-deploy` 往 profile 的 `cordis.patch.yml` 插一行，而那条命令写死
  `profiles/web` ⇒ 桌面版（`profiles/desktop`）永远挂不上 ⇒ 声明了 external 的管家面板
  同步 require 必 MISS ⇒ **侧边栏连入口都不出现，且没有任何报错**（A-8 关 4 真机实测）。
- `@kira905/dsh-butler-panel` 下界 `^0.9.3` → `^0.9.5`：0.9.4 修了挂载条目与 require 的名字，
  但客户端模块 `id` 还写着不带 scope 的旧名 ⇒ 桌面版**启动即弹「应用无法启动」**；0.9.5 修掉。
  ⚠️ 0.9.4 不要用。
- `@kira905/dsh-ecosystem-panel` 下界 `^0.5.1` → `^0.5.5`：默认读**当前** profile（不再写死 web），
  新增「客户端装配」类目（四类病灶各给三段人话）。

### 已知阻断（本版未修，归别的卡）

- `@kira905/dsh-task-board-local@1.2.0` 的客户端写死 `require("dsh-host-adapter-client")`（不带 scope），
  而注册表装来的适配层真名带 scope ⇒ 同步 require MISS ⇒ 宿主报
  `web boot: 1 entry did not activate` ⇒ **桌面版直接起不来**。剔除看板后一切正常。
  修法见交付报告 `docs\交付报告-A8关4-载体与指引-20261109.md` 的「待拍板」第 1 条。

## [Unreleased]

（暂无）

## [0.3.27] - 2026-11-09

> 一句话：**修 A-8 关 2 的阻断** —— 新人装完清单、打开面板，看板红条
> `Host 操作失败：Unexpected token 'o', "not found" is not valid JSON`、五列全空。
> 根因不在端口也不在账本：清单钉的 **1.1.5 在 0.2.2 线上宿主半没挂载**（`dsh.client.inject` 少声明
> `@deepseek-ai/dsh-api-remotes`、也没把 `dsh-host-adapter-client` 声明为 `external`），而这条线
> 上真正在跑的是另一份 1.2.0。修法 = 把那份 1.2.0 收进开源仓、发 npm，本清单下界跟一格。

- `suite-manifest.json`：`@kira905/dsh-task-board-local` `^1.1.5` → `^1.2.0`，note 写清 1.1.5 在 0.2.x 上坏在哪。
- 同批发布：`@kira905/dsh-task-board-local@1.2.0`（归档页 / 多实例 / 收件箱 / 删搬闸 / 客户端 external）。
- 重建 `dist/dsh-butler-install-0.3.27-win-x64.exe`（内嵌清单逐字节更新）。
- 判据：隔离 profile **只装 1.2.0**（旧的同功能副本挪走）⇒ `GET /api/task-board/state` 200 + 真实账本 212 张卡 +
  侧边栏面板五列有数据（截图 `_archive\a8-e2e-20261109\shots\s13-board-scoped-120.jpg`）；`verify-release` 三包全过。

## [0.3.26] - 2026-11-09

> 一句话：**修 A-8 关 1 的硬阻断** —— 清单第 17 项在**任何**全新全局前缀下必挂，因为
> `dsh-quality-toolkit@0.3.0` 与 `dsh-ops-toolkit@0.2.0` 抢同一个 bin 名 `dsh-plan-gate`（npm 报
> `EEXIST`，rc=3，整批装不完；反序装也一样）。修法 = quality 侧把那条命令改名成 **`dsh-plan-gate-qc`** 发 **0.3.1**，
> 本清单下界跟一格 —— 不是「谁覆盖谁」，两份实现本来就不是同一样东西。

- `suite-manifest.json`：`@kira905/dsh-quality-toolkit` `^0.3.0` → `^0.3.1`，note 写清为什么不能回退
  （0.3.0 带撞名的 bin，回到 `^0.3.0` 等于把撞名版本重新放进范围）。
- `test/fixtures/npm-latest-snapshot.json`：quality `0.3.1`（发布后现取，`capturedAt` 同步）。
- 重建 `dist/dsh-butler-install-0.3.26-win-x64.exe`（内嵌清单逐字节更新）。
- 判据：全新空前缀按清单 19 项整装 **rc=0 / 零 EEXIST**（连装两遍也过）；反序两条都 rc=0；
  19 项 bin 表从 registry 现取的**交集为空**；`verify-release` 五道闸全过。

## [0.3.25] - 2026-11-09

> 一句话：engine 补了个 **0.5.2**（回修：把通道痕迹从公开包清掉 —— 撤回一个撞「通道不开源」红线的判定件、
> 另一件的登记表与注释全中性化），panel 跟一个 **0.9.3**（对应那一件的显式降级话术）。
> 闸④ 口径 = 清单下界与实体版本逐字对齐，所以两条下界一起跟。

- `suite-manifest.json`：`@kira905/dsh-butler-engine` `^0.5.1` → `^0.5.2`；
  `@kira905/dsh-butler-panel` `^0.9.2` → `^0.9.3`。
- `test/fixtures/npm-latest-snapshot.json`：engine `0.5.2` / panel `0.9.3`（发布后现取，`capturedAt` 同步）。
- 重建 `dist/dsh-butler-install-0.3.25-win-x64.exe`（内嵌清单逐字节更新）。
- 判据：`npm test` 全过；`verify-release` 五道闸全过（含 exe 内嵌清单逐字节比对）。

## [0.3.24] - 2026-11-09

> 一句话：engine 补了个 **0.5.1**（只订正 `examples/first-run.json`：`barewatch` 撤出首开组 ——
> 它 rc=0 但内部被组件版本门跳过），**闸④ 口径 = 清单下界与实体版本逐字对齐**，所以清单跟一格到 `^0.5.1`。

- `suite-manifest.json`：`@kira905/dsh-butler-engine` `^0.5.0` → `^0.5.1`。
- 重建 `dist/dsh-butler-install-0.3.24-win-x64.exe`（内嵌清单随之更新）。
## [0.3.23] - 2026-11-09

> 一句话：**把 engine 下界跟到 `^0.5.0`、面板下界跟到 `^0.9.2`**，对应「面板在只有 npm 包、没有私有工具目录的机器上也能出真数据」那一批（engine 0.5.0 补了 8 个库模块 + `examples/first-run.json`；panel 0.9.2 加了多路回落）。闸④ 口径 = 清单下界与实体版本逐字对齐，所以下界必须跟着实体走。

- `suite-manifest.json`：`@kira905/dsh-butler-engine` `^0.4.1` → `^0.5.0`；`@kira905/dsh-butler-panel` `^0.9.1` → `^0.9.2`。
- 重建 `dist/dsh-butler-install-0.3.23-win-x64.exe`（内嵌清单随之更新）。
- 判据：`npm test` 全过（含「清单 vs registry 漂移」那条 —— 发布前红、发布后转绿，本次按发布后读数）；`verify-release` 五道闸 5/5。

## [0.3.22] - 2026-11-09

> 一句话：**engine 下界再跟一格到 `^0.4.1`（0.4.1 是 0.4.0 的文档计数订正版），erify-release 闸④ 要求下界与实体版本对齐。

### Changed

- `suite-manifest.json`：`@kira905/dsh-butler-engine` `^0.4.0` → **`^0.4.1`**。
- `test/fixtures/npm-latest-snapshot.json` 再刷一次（engine 0.4.0 → 0.4.1）。
- exe 重建（`dsh-butler-install-0.3.22-win-x64.exe`，内嵌清单逐字节相同）。

## [0.3.21] - 2026-11-09

> 一句话：**调度内核下界跟到 `^0.4.0`**（那一版开始随包附带作业脚本），顺带把管家面板下界补到 `^0.9.1`。

### Changed

- `suite-manifest.json`：`@kira905/dsh-butler-engine` `^0.3.1` → **`^0.4.0`**。
  引擎 0.4.0 起随包附带 30 个作业脚本（`jobs/`，覆盖 41 条作业），入口按三级解析
  （包内 `jobs/` → 环境变量 `BUTLER_JOBS_DIR` → 内核位置），都不在就记 `skipped-missing-src` 且不发红。
  **默认仍然全关** —— 脚本在位不等于在跑。
- `suite-manifest.json`：`@kira905/dsh-butler-panel` `^0.9.0` → **`^0.9.1`**（下界落后一格，`verify-release` 闸④ 会判红）。
- 引擎条目 note 改写：不再说"不附带作业脚本"，改成"附带但默认全关 + 三级解析"。
- `test/fixtures/npm-latest-snapshot.json` 刷新到现网 latest。
- exe 重建（内嵌清单与仓内逐字节相同）。

### Note

- 0.3.18 / 0.3.19 / 0.3.20 三版当时没有在这里补条目（仓内清单与 exe 都已跟进，只有变更记录缺行）；
  本版补记这一条，不追溯回写那三版的正文。

## [0.3.17] - 2026-11-08

> 一句话：**清单里 `@kira905/dsh-memory-toolkit` 下界跟上 `^0.5.2`**（那一版订正了命令表里三行「缺省是否动库」）。

### Changed

- `suite-manifest.json`：`@kira905/dsh-memory-toolkit` `^0.5.1` → **`^0.5.2`**。
  0.5.2 是纯文档订正：`dsh-mem-sync` / `dsh-mem-sweep` / `dsh-mem-doc-index` 三条**缺省真写**
  （写向量库 / 索引库），0.5.1 的表错写成「干跑」。对「装出来的功能」没差别，但装到错的那版会误导人对着生产库跑。
- `test/fixtures/npm-latest-snapshot.json`：`dsh-memory-toolkit` `0.5.1` → `0.5.2`，`capturedAt` 刷新。
- `dist/dsh-butler-install-0.3.17-win-x64.exe` 重建（exe 内嵌清单变了）。
- 未上传网盘。

## [0.3.16] - 2026-11-08

> 一句话：**清单里 `@kira905/dsh-memory-toolkit` 下界刷到 `^0.5.1`**（那一版才把 15 条引擎 CLI 接上 `bin`）。

### Changed

- `suite-manifest.json`：`@kira905/dsh-memory-toolkit` `^0.5.0` → **`^0.5.1`**。
  0.5.1 起 `memory-engine/cli/` 那 15 条才有 `bin`（前缀 `dsh-mem-`），并修了 13 个脚本缺 shebang
  导致 npm shim 无解释器的坑（已发的 `dsh-memory-summary` 因此一直是坏的 —— Windows 上静默 rc 0 无输出）。
  本项按「命令能敲出来」判，低于 0.5.1 装完敲不出来。
- `suite-manifest.json` 同条 `note`：口径从「三个命令行」改成 **19 条**（4 条 `dsh-memory-*` + 15 条 `dsh-mem-*`），
  并把下界理由一并改到 0.5.1（原 0.2.0 的挂载理由仍成立，取严的那条写进 note）。
- `test/fixtures/npm-latest-snapshot.json`：`dsh-memory-toolkit` `0.5.0` → `0.5.1`（离线夹具跟现实对齐），`capturedAt` 随之刷新。
- `dist/dsh-butler-install-0.3.16-win-x64.exe` 重建（exe 内嵌清单变了，不重建闸⑤必红）。
- 未上传网盘（上传属主人点头项）。

## [0.3.15] - 2026-11-08

> 一句话：**清单里 `@kira905/dsh-memory-toolkit` 下界刷到 `^0.5.0`**（记忆包出了会话捕获管线）。

### Changed

- `suite-manifest.json`：`@kira905/dsh-memory-toolkit` `^0.4.1` → **`^0.5.0`**。
  0.5.0 新增「会话捕获管线」（自己的会话日志 → 候选 → 账本 → 批次撤回）、相似度模块收敛与四个只读探针；
  上界不封，装最新。
- `test/fixtures/npm-latest-snapshot.json`：`dsh-memory-toolkit` `0.4.1` → `0.5.0`（离线夹具跟现实对齐）。

## [0.3.14] - 2026-11-08

> 一句话：**安装清单加第 19 项 —— 开源出去的大管家面板 `@kira905/dsh-butler-panel@0.9.0`**（界面 / plugin / 自动挂载）。

### Added

- `suite-manifest.json` 新增 `@kira905/dsh-butler-panel`（`^0.9.0` · group=界面 · mount=auto）：
  生态总览 / 任务 / 日报周报 / 资产一屏看完，宿主半 + 浏览器半都在包内，装完即挂载。
  浏览器端依赖 `@kira905/dsh-host-adapter-client`（清单里单列，两条都装才有界面）。
  ⚠️ 包里**刻意不带任何图片**：仓内 271 张截图是视觉回归基线、画面里含内部信息，一律不进货。
- `test/fixtures/npm-latest-snapshot.json` 补 `dsh-butler-panel@0.9.0`。

### Changed

- 形状守卫跟着改：清单 **18 → 19 项**、插件 **6 → 7 项**（`test/test-manifest.mjs` 里是显式审核点，改清单必须同时来改它）。

### Tests

- **701 条断言全过**。

## [0.3.13] - 2026-11-07

> 一句话：**清单里调度内核的下界抬到 `^0.2.2`**（脱敏残留收尾版），其余不变。

### Changed

- `suite-manifest.json`：`@kira905/dsh-butler-engine` 的 `versionRange` `^0.2.1` → `^0.2.2`
  （0.2.2 只改注释/作业表登记/占位写法与 `.gitignore`，**没有行为变更**；抬下界是为了让新装机器直接拿到
  「脱敏扫描待复核 0」的那份）。
- `test/fixtures/npm-latest-snapshot.json`：同一条快照 `0.2.1` → `0.2.2`，`capturedAt` 随之刷新。
- exe 已随本版重建（内嵌清单与本文件逐字节一致）。

## [0.3.10] - 2026-11-07

> 一句话：**清单里多了第 18 项 —— `@kira905/dsh-butler-engine`（真调度内核）**，其余统统不变。

### Added

- `suite-manifest.json` 新增 `@kira905/dsh-butler-engine`（`type: cli` / 组 `CLI` / 探针 `butler-tickd` 存在性）。装在 `dsh-butler-core` 之后。注意：它是**真常驻调度**，装完一条作业都不会自己跑（不附带作业脚本，默认全关），要哪条自己在 `butler-autonomy.json` 里放行。
- `test/fixtures/npm-latest-snapshot.json` 加同一条（0.1.0），否则离线漂移判据会把新条目判成「清单超前于 registry」。
- `test/test-manifest.mjs` 的形状守卫同步：17→18 项、11→12 条命令行（这是**刻意的审核点**，加清单必须来改）。

### Changed

- 随包清单条数 **17 → 18**（插件仍 6 条，命令行 11 → 12 条）。exe 已随之重建。

## [0.3.9] - 2026-11-07

> 一句话：**修掉「桌面版用户装完一个插件都看不到」。** exe 双击不带参数时默认落在 `web`，而桌面版只加载 `desktop` —— 装的那套界面永远不加载。

### Fixed

- **默认 profile 的自动判定漏了一种最常见的情况**：原来的自动切 desktop 只在「数据根里只有 `desktop`、没有 `web`」时生效。可**同机装了 CLI 版 + 桌面版**的人两个 profile 都在 ⇒ 不命中 ⇒ 落回 `web`（2026-11-07 00:4x 在本机实测复现：exe 不带参数启动，向导 `profile = web`）。
- 新增一条判据：**桌面版（Electron）正在运行时，默认就用 `desktop`**（探测得到 `source === 'process'`）。用户显式给 `--profile` 时仍然完全尊重，绝不偷改。
- 桌面版探测改为**在向导启动时解析一次**并复用（`options.desktopPre`），这样既保留「每请求零 spawn」，又有资格做进程探测（原来探进程这条路在 `--ui` 下根本没启用）。

### Changed

- `test/fixtures/npm-latest-snapshot.json` 刷到当前 registry 真值（三个包 0.5.0/0.5.0/0.3.0 → **0.5.1/0.5.1/0.3.1**），否则离线漂移判据会把「清单已更新」误判成「清单超前于 registry」。

### Tests

- 新增 `test/test-decide-profile.mjs`（11 条）：桌面版正在跑 ⇒ 切 desktop / 显式 `--profile web` 不被覆盖 / 无桌面版保持 web / 找不到自带命令必须报错 / 纯桌面版机器行为不退化。
- 全套 **701 条断言全过**（0.3.8 是 690）。

## [0.3.8] - 2026-11-07

> 一句话：**清单三条下界跟上刚发的插件补丁版**（`butler-archive` / `ecosystem-panel` → `^0.5.1`，`session-title-live` → `^0.3.1`）。
> 那三个包在 0.5.1 / 0.3.1 里删掉了 `peerDependencies` 里的 `dsh`（那句区间对预发布宿主必然误报，纯噪音），本版让安装清单指向它们。

### Changed

- `suite-manifest.json` 三条 `versionRange` 下界：`dsh-butler-archive` `^0.5.0`→**`^0.5.1`**、`dsh-ecosystem-panel` `^0.5.0`→**`^0.5.1`**、`dsh-session-title-live` `^0.3.0`→**`^0.3.1`**。其余 14 条一动没动。
- **exe 已跟着重建**（清单内嵌 SEA blob，不重建那只双击的 exe 会照旧按老清单装）。

### 为什么必须发这一版

清单文件在发布包里（`files` 含 `suite-manifest.json`），不改版本号发不出去；而不刷这三条，用户装到的还是旧的 0.5.0 / 0.3.0 —— 那条 peer 噪音就还在。

### 配套

- 复验器具 `scripts/verify-release.mjs` 五道闸一起跑：tarball 重下核 shasum / 隔离装无 peer 警告 / 静态 peer 扫描 / 清单↔实体版本 / **exe 内嵌清单逐字节**。

## [0.3.7] - 2026-11-06

> 一句话：**结掉 0.3.6 留下的两条 Known issue。**
> ① 命令不再过 shell —— 根因是 Windows 的 `cmd.exe /c` 把 `pkg@^x.y.z` 里的 `^` 当转义符吃掉，
> 于是 `npm i -g` 与 `dsh plugin add` 双双退化成"精确钉死下界"，而老自检只查"落在区间内"，
> 下界当然在区间内 ⇒ 整批 rc=0 全绿、装的全是旧版（实测 11/11 个 CLI 包如此，其中一个还装到了
> 已 deprecate 的 0.1.0）。
> ② 桌面版（Electron）不再是"结构性不支持"：认出来之后**改用它自带的那条 dsh.cmd**，找不到就硬拒绝。
> 装后自检同时升级：从"落在区间内"改成"落在区间内 **且** 是区间内注册表当前可用的最高合规版"。

### Fixed

- **缺陷 A · 参数不许过 shell（最严重）**：`lib/exec.mjs` 的 `spawn(cmdline, {shell:true})` 换成
  `spawn(exe, args, {shell:false})`，并把 `.cmd` 壳**解析成它真正要跑的可执行 + 参数**：
  `npm.cmd → node npm-cli.js`、`dsh.cmd → node lib/bin.js`、桌面版 `dsh.cmd → "DeepSeek Harness.exe"
  --expose-internals … dsh-desktop-host/lib/cli.js`（连同壳里 `set` 的环境变量，例如 `ELECTRON_RUN_AS_NODE=1`）。
  为什么不能只写 `shell:false`：Node 18.20+ 起 `spawn('npm.cmd')` 直接 **EINVAL**，裸 `spawn('npm')` 是 **ENOENT**（本轮实测）。
  解析不出来才退回 `cmd.exe /d /s /c`，且参数按**两层**解析的实测结果转义（`^` 要写四个 —— 写两个仍会被批处理再吃一次）。
  🔴 超时清理的 `taskkill` 本来就是 `.exe`，未回到 shell。
- **PATH 上同名命令挑错壳**：npm 全局目录里 `dsh`（bash 脚本）、`dsh.cmd`、`dsh.ps1` 同时存在，
  老逻辑"无扩展优先"会拿到那个 spawn 必失败的 bash 脚本。新增 `findExecutableOnPath()`，按 `.exe → .cmd → .bat` 排。
- **缺陷 B · 桌面版（Electron）**：新增 `lib/desktop.mjs`。探测三处证据（数据根里的 `profiles/desktop`、
  `DSH_DESKTOP_DIR`/`DSH_DESKTOP_CLI`、常见安装目录、运行中的桌面版进程反查），认出后
  `--profile desktop` 的命令改用 `<安装目录>\resources\runtime\cli\bin\dsh.cmd`。
  找不到自带命令 ⇒ **rc=2 硬拒绝** + 桌面版专属提示（不再拿 npm 版 CLI 去撞宿主的
  `profile "desktop" is managed exclusively by the Electron application`）。
  桌面版只加载 `desktop` 这一个 profile：显式 `--profile web` 时打一行提示但不阻断（同机双装是合法状态）。
- **桌面版的挂载判据**：桌面版 CLI **不提供** `--dump-config`（实测自带命令与 PATH 上的 CLI 都回同一句拒绝），
  老实现只能记"未知" ⇒ 桌面版用户永远看不到挂载结论。改读 profile 的 `dsh.profile.bundles`
  （Electron 宿主按它装配，登记即生效）。

### Changed

- **装后判据升级（判据要能红）**：`lib/registry.mjs` 新增「注册表上这个区间内现在最高是哪一版」，
  用一条只读命令 `npm view <包>@<区间> version --json`，同进程内按包缓存（每步判据 + 收尾整批核对不会重复问）。
  判据从「落在区间内」改成「落在区间内 **且** 不落后于区间内最高合规版」；
  取不到注册表时**不冒充通过**：状态记 `unknown`，汇总里单列「N 项没核是否落后」。
- **新增 `--no-registry`**：显式关掉那条核对（离线 / 私有源要登录时用），关掉后汇总里照样写明"没核过"。
- `--ui` 的默认 profile 在"数据根里只有桌面版自建的 `desktop` profile、没有 web"时自动用 `desktop`，
  并在预览里标明来源（`profileSource: auto-desktop`）；用户亲手写的 `--profile` 一律不改。
- `buildSuiteState` 的 `state` 增加 `desktop` 与 `registryCheck` 两格，向导页与 CLI 同源。

### Tests

- 断言 **613 → 690**（新增 77 条），全部通过。三个新夹具：
  - `test/test-exec-resolve.mjs`：命令解析 + `^` 保真（**子进程真的收到了什么**，不是"函数返回了什么"），
    含阴性对照（同一串过一遍 `cmd /c` 必须丢 `^`，证明判据不是空转）。
  - `test/test-registry.mjs`：区间内但明显落后 ⇒ **必须判红**（端到端 rc=3）；取不到注册表 ⇒ `unknown`；`--no-registry` ⇒ 汇总明说没核。
  - `test/test-desktop.mjs`：伪造一套桌面版安装目录 ⇒ 命令改用自带命令、装进 `dsh.profile.bundles`、
    卸干净；再把目录撤掉 ⇒ rc=2 + 桌面版专属提示。
- 金标 `test/fixtures/legacy-dryrun.txt` 随判据文案同步更新（守护的是"CLI 输出不被 --ui 改造污染"，不是判据文案本身）。

### 这一版必须重建 exe

exe 把向导页与 `suite-manifest.json` 内嵌进 SEA blob，**代码改了不重建 = 双击跑的还是旧逻辑**
（旧逻辑恰恰是"每项都装成下界"那套）。验收不能看体积：要拿切出来的内嵌段 sha256 与仓内文件逐字节比。

### Known issue / 待拍板

- **`--uninstall` 不带 `--apply` 会被当成演练**（演练优先的既有语义）。help 里没写清，容易误解。
  本轮没动它 —— 改语义会影响 `--ui` 的"卸载这次装的"。已在交付报告里列为待拍板。

## [0.3.6] - 2026-11-06

> 一句话：**清单 10 条下界刷到 npm 上当前真发的版本**，其中 `@kira905/dsh-ops-toolkit` 那条是**安全修复**
> —— 旧下界 `^0.1.0` 会把用户装到已 deprecate 的 0.1.0（npm 告警原文：含真实账号残留，0.1.2 已清除）。
> README 补两处：项数 16→17、**桌面版（Electron）结构性不支持**的警示。

### Changed

- **10 条 `versionRange` 下界刷到 npm latest 当前版**（`node test/range-drift.mjs` 判据 17/17 全接受）：
  `host-adapter-client` `^0.1.1`→**`^0.1.2`**、`board-toolkit` `^0.1.2`→**`^0.1.3`**、`session-toolkit` `^0.1.1`→**`^0.1.2`**、
  `net-toolkit` `^0.1.0`→**`^0.1.1`**、`notekit` `^0.1.0`→**`^0.1.1`**、`nurse` `^0.1.0`→**`^0.1.1`**、
  `firstaid` `^0.1.3`→**`^0.1.4`**、`ops-toolkit` `^0.1.0`→**`^0.1.2`**（⚠️ 安全）、
  `closure-tools` `^0.1.1`→**`^0.1.2`**、`diagnostics-extra` `^0.1.0`→**`^0.1.2`**。
  其余 7 条本来就等于 latest，一个字节没动。**只升不降**，脚本带备份 + 回读校验。

### 为什么下界必须等于"想给用户的版本"（本轮实测的原因）

2026-11-06 隔离真装 17 项（rc=0 全绿）抓到：**11/11 个 CLI 包的实装版本正好等于清单下界**，其中 10 个落后 npm latest，
`dsh-ops-toolkit` 装到被 deprecate 的 `0.1.0`。

根因是 `lib/exec.mjs` 起子进程用 `shell: true` ⇒ Windows 走 `cmd.exe /c`，而 **`^` 是 cmd 的转义符**：

```
cmd /c "echo @kira905/dsh-ops-toolkit@^0.1.0"
→ @kira905/dsh-ops-toolkit@0.1.0        ← ^ 被吃掉
```

⇒ `npm i -g <包>@^x.y.z` / `dsh plugin --profile <p> add <包>@^x.y.z` 双双退化成**精确钉死下界**。
而装后自检的判据是"实体版本落在期望区间内"，下界当然在区间内 ⇒ **永远绿，这个错自检发现不了**。

⚠️ 本版只是把下界顶到正确位置（止血）；**`shell:true` 那处代码缺陷另开卡修**（改 `shell:false` + 显式调 `npm.cmd`/`dsh.cmd`，并让自检能判红"区间内但明显落后"）。

### Fixed

- **README 项数 16 → 17**（3 处）：清单自 `dsh-task-board-local` 并入后就是 17 项，README 一直没跟上。
- **README 新增桌面版警示**：桌面版（Electron）的 `desktop` profile 由 Electron 独占，**npm 装的 CLI 直接拒绝其插件管理请求**
  （实测 `dsh plugin --profile desktop add …` ⇒ `error: profile "desktop" is managed exclusively by the Electron application`，rc=1）。
  本工具插件那 6 步全走 `dsh plugin` ⇒ 对桌面版结构性无效；写在首屏，避免用户装完一个插件都看不到。

### Known issue（本版未修）

- **桌面版适配**：只做了"写清楚不支持"，没做检测与硬拒绝 —— 桌面版用户跑本工具仍可能往 `profiles/web` 装进一套界面永远不加载的插件（假绿）。
- **`shell:true` 吃 `^`**：见上。

## [0.3.5] - 2026-11-06

> 一句话：**清单追上了 npm 上真发的那一套** —— 4 条区间刷到 registry 上的当前最新（旧区间会把用户按在旧版上，
> 而装后自检读同一份清单、照样报绿 ⇒ 假绿），`excluded[]` 里 router 的安装指针从 `@0.2.0` 改成 `@0.4.0`（原来那行指向的版本身后已经落后两个大版本）；
> **exe 必须跟着重建**：exe 把 `suite-manifest.json` 整份内嵌进 SEA blob，不重建的话双击跑的那只仍旧按老清单装。

### Changed

- **清单 4 条 `versionRange` 刷到 npm latest 的当前大版本**（`node test/range-drift.mjs` 联网判据从 4 漂移 → 全部接受）：
  `@kira905/dsh-butler-archive` `^0.4.0` → **`^0.5.0`**、`@kira905/dsh-session-title-live` `^0.2.7` → **`^0.3.0`**、
  `@kira905/dsh-memory-toolkit` `^0.3.0` → **`^0.4.1`**、`@kira905/dsh-quality-toolkit` `^0.2.0` → **`^0.3.0`**。
  其余 13 条区间本来就接受当前 latest，**一个字节没动**。
- **`@kira905/dsh-session-title-live` 那条 `note` 原样保留**：它解释「下界为什么必须硬排除 0.2.4–0.2.6」（那三版写的 `source.kind === 'plugin'`
  被 DSH 0.2.1+ 的日志准入硬拒，会话开几秒就 failed），抬到 `^0.3.0` 之后这条依据仍然成立、仍然值得留在清单里。
- **`test/fixtures/npm-latest-snapshot.json` 刷到真 npm latest**（`capturedAt` → `2026-11-06T08:29:06+08:00`）：
  只有上面那 4 项变了，其余 13 项现取一致、未改。不刷的话离线判据会红（新区间在快照看来"超前于 registry"），
  而那条红抓的正是"快照过期"，不是代码坏了。

### Fixed

- **`excluded[]` 里 router 那行的安装指针是假指针**：`reason` 末句原写 `npm i -g @kira905/dsh-router-toolkit@0.2.0`，
  而 0.3.0 / 0.4.0 都已发到 npm ⇒ 按那行装会拿到旧版。改成 **`@0.4.0`**。

### 为什么这版必须重建 exe

`scripts/build-exe.mjs` 会把 `suite-manifest.json` 整份打进 SEA blob（exe 是"自带清单"的，不读仓里那份）。
清单改了而不重建 exe，双击跑的那只就还是**老清单**：一样会假绿，而且因为 exe 是最容易被用户拿去双击的入口，这条最要命。
本版的 `dist/dsh-butler-install-0.3.5-win-x64.exe` 已按新清单重建，并逐字节核过内嵌清单与仓内 `suite-manifest.json` 一致。

### 已知、这次没动

- **网盘上的 exe 仍是 0.3.1**：上传是另一件事（红线，要主人点头），README 里那段的文件名/体积照旧指向它，
  不指向网盘上不存在的文件 ⇒ 新版 exe（0.3.5）只在本地 `dist/` 与仓里构建。

## [0.3.4] - 2026-11-05

> 一句话：**「我运行 exe，它说我没装 DSH」这个反馈的修复** —— exe 的体检判据没变（缺 dsh 就不继续，这是设计），
> 变的是提示文案：README 里两处与事实不符的说法改掉（exe 不是"不用先装环境"、前提里漏了 npm），
> `printMissingDsh()` 从"一句到底"拆成三档，让「装了但跑不起来」「装的是桌面版」这两种人不再看到同一句"还没装"。

### Fixed

- **README 里说 exe「不用先装环境」是假话**（用户 2026-11-05 反馈「为什么我运行 exe 会提示我没有安装 dsh」）。
  exe 自带的只是 **node 运行时**，`dsh` 与 `npm` 仍必须本机有、且在 PATH 里能跑 —— 文案改成真话：
  「exe 自己不用装 Node；但得先有 DSH 和 npm，exe 只装大管家组件」。
- **README「这个 exe 的前提」漏了 npm**，且把「自带 node 运行时」的好处写成了「你机器上 node 不在 PATH 也能起界面」
  —— 起界面确实行，但**装插件那一步要调本机 npm**，这句会被读成"全流程不依赖本机 node"。两条都补准。
- **`printMissingDsh()` 只有一档提示**：装的是图形/桌面版 DSH（没带 CLI）、或 `dsh` 在 `where` 里能找到但
  `--version` 跑不起来（PATH 半生效 / 权限 / 装坏了），看到的都是同一句「这台电脑上还没装 DSH」，帮不到定位。
  现按 `where dsh` 的结果分档（判据仍是「dsh 跑不起来就不继续」，没动）：

  | 档 | 条件 | 说什么 |
  |---|---|---|
  | A | `where dsh` 也找不到 | 维持「还没装 DSH」+ `npm i -g @deepseek-ai/dsh` + nodejs.org |
  | B | `where` 找到了、`--version` 跑不起来 | 「找到了 dsh，但它跑不起来」+ **路径** + **系统原话** + 三条排查（重开窗口让 PATH 生效 / 权限 / 重装） |
  | C | A、B 都补 | 「如果你装的是桌面版/图形版 DSH，它可能没带命令行 → 再装一个命令行版」 |

- **exe 体检返回值多了 `where` 字段**（`checkPrerequisites()` 失败时一起带回），它正是 A / B 两档的分档判据。

### 已知、这次没动

- **网盘上的 exe 仍是 0.3.1**：上传是另一件事，README 里那段的文件名/体积照旧指向它（并加了说明），
  不指向网盘上不存在的文件。新版 exe（0.3.4）只在本地 `dist/` 与仓里构建。

## [0.3.3] - 2026-11-05

> 一句话：**照这份清单装，才会真的拿到新版** —— 把 `@kira905/dsh-memory-toolkit` 的区间从 `^0.2.0` 抬到 `^0.3.0`（旧区间上界停在 0.3.0 之前，新版发出去也装不上），并把三个"能装但不该默认装"的后建仓登记进 `excluded`。

### Changed

- **清单 `@kira905/dsh-memory-toolkit` 的 `versionRange`：`^0.2.0` → `^0.3.0`。**
  `^0.2.0` 的语义是 `>=0.2.0 <0.3.0`，而 0.3.0 已在 npm 上 ⇒ 照旧清单装会拿到 **0.2.1**（少了「来源血缘 `source_ids`」与「记忆时效 `until`」两件能力），
  而装后自检读的是**同一份清单**，照样报绿 ⇒ 这是**假绿**。`node test/range-drift.mjs` 联网判据原本就在报这条。
- **`excluded[]` 追加三项**：`dsh-life-toolkit` / `dsh-peer-toolkit` / `dsh-router-toolkit`。
  三者**都装得上**，但都是**另有用途的可选件**（生活侧 / 多机对偶 / Router），默认装进来只是多一份用不上的东西 ⇒ 不进 `items`（不拉长默认安装面），
  各自在 `reason` 里写一句单独装命令。`items` 仍是 **17 项**，默认安装行为零变化。
- **`README.md` 的 `excluded[]` 说明跟着改口径**：原文只写「不可安装项」，与新增的三项打架 ⇒ 改为「**不随这套默认安装的项**」，两类都写清（①不是包的目录 ②能装但另有用途的可选件）。
- **`test/fixtures/npm-latest-snapshot.json` 刷到真 npm latest**（`capturedAt` → `2026-11-05T01:31:27+08:00`）：
  `dsh-memory-toolkit` 0.2.0 → **0.3.0**、`dsh-ops-toolkit` 0.1.1 → **0.1.2**，其余 15 项现取一致、未改。
  不刷的话离线判据会红（`^0.3.0` 在快照看来"超前于 registry"），而且那条红抓的正是"快照过期"。

### Added

- `publishConfig: { "access": "public" }` —— 前几版一直缺（同批另两个包都有），包本身早就 public、功能无碍；这次动它顺手补上。

### 未改（顺带核过，只登记）

- `items` 17 条一条没动，`versionRange` 除上面那条外全部照旧。
- 本版**不重建 exe**：`dist/` 在 `.gitignore` 里、不随 npm 发；exe 是网盘分发物，重建与上传另算。
- 订正上一版记录：`[0.3.2]` 那条写「未发 npm（npm latest 仍是 0.3.1）」，那是**当时**的事实；后来 0.3.2 已补发到 npm（`latest=0.3.2`、`time.0.3.2 = 2026-11-04T17:10:44Z`）。本条不改历史条目，只在此注明。

## [0.3.2] - 2026-11-03

> 本版**只重建 exe 分发物，未发 npm**（npm `latest` 仍是 0.3.1；`package.json` 抬到 0.3.2 是为了让 exe 文件名与产物内嵌版本号对得上）。
> 一句话：**内嵌清单把 `@kira905/dsh-session-title-live` 钉到 `^0.2.7`，避开 0.2.4–0.2.6 那个「每个会话开起来就 failed」的崩溃。**

### Changed

- **清单 `@kira905/dsh-session-title-live` 的 `versionRange`：`^0.2.5` → `^0.2.7`。**
  0.2.4–0.2.6 把消息的 `source` 写成 v4 已退役的 `{ kind: 'plugin', plugin: … }`，而 DSH 0.2.1+ 的会话日志 v4 准入**硬拒** `source.kind === 'plugin'`；
  它写的 `session/title-llm-request` 事件的 `messages` 恰在那份校验的扫描列表里 ⇒ **每一个会话**开起来 1–5 秒就 failed，
  坏行还让界面「查看会话」报 `format v4 message requires a producer-owned source kind`。0.2.7 是修复版。
  为什么非改区间：`^0.2.5` 理论上也会解析到 0.2.7，但只要用户机器上有缓存 / lockfile / 代理快照，
  就可能落到坏版本 ⇒ **必须从区间上硬排除**。该条 note 已把这段理由写进去（改区间的人会先看到）。
- **`test/fixtures/npm-latest-snapshot.json` 跟着刷到真 npm latest**（`capturedAt` 改 2026-11-03T14:36:02+08:00）：
  `dsh-session-title-live` 0.2.6 → **0.2.7**，其余 16 项现取与快照逐项一致、未改。
  不刷的话 range-drift 会立刻红（`^0.2.7` 不接受 latest 0.2.6），而且那条红是**对的** —— 它抓到的是"快照过期"。

### 未改（顺带核过，只登记）

其余 16 项区间现取核对：5 项下界恰好等于 latest；11 项区间内还接纳一个更旧的版本（旧版本本身**无已知缺陷记录**），
属"理论上可被缓存落到旧版"的通用暴露面，本版不动它们 —— 只有 `dsh-session-title-live` 是**区间里真有已知坏版本**的那一项。

## [0.3.1] - 2026-11-02

> 本版**已发布到 npm**（`latest = 0.3.1`），Gitee / GitHub 双端打 tag `v0.3.1`。
> 一句话：清单补上「任务看板」界面 —— 原来照清单装完，用户拿到的是 30 个看板命令，
> 侧边栏里却**没有**看板界面。

### Added

- **清单加 `@kira905/dsh-task-board-local`（`^1.1.5`，组「界面」，`mount: auto`）**：
  上游任务看板插件的 fork（宿主半 + 浏览器半都在包内），装完侧边栏出现「任务看板」。
  两条必须写进 note 的坑：① 它与官方任务看板插件**抢同一个位置、二选一**（装之前先看 profile 的组合列表里有没有官方那份）；
  ② **界面在它、那 30 个看板命令在 `@kira905/dsh-board-toolkit`** —— 两件分开装，别以为装了界面就有命令。
  别名给的是「任务看板 / 看板界面」而不是「看板」：后者已被 board-toolkit 占着，
  清单校验器不许别名重复（会造成 `--only` 歧义）。

### Changed

- **`test/fixtures/npm-latest-snapshot.json` 按真网络刷到 17 项**（`capturedAt` 跟着改）：
  清单加了包而快照不跟，range-drift 的「快照集合 == 清单集合」判据会静默漏判。
- **`test/range-drift.mjs` 的项数判据去掉写死的 16**，改成「与快照包数一致」——加一条包不该要人改两处判据。
  `test/test-manifest.mjs` 的**形状守卫**仍显式钉「17 项 / 6 插件 / 11 命令行」：那是刻意的审核点，
  改清单的人必须同时来改它。
- **新增一条别名可用性断言**：`--only 任务看板` 必须选中 `@kira905/dsh-task-board-local`。

## [0.3.0] - 2026-10-31

> 本版**已发布到 npm**（`latest = 0.3.0`），Gitee / GitHub 双端打 tag `v0.3.0`。
> 它是 V3O「可视化安装」那一批的落点：向导页从"能看"变成**能点着装**，再配一个连 node 都不用装的自足 exe。

### Added

- **向导页能点着装**（`--ui`）：预览（只算不做）→ 【确认，开始】→ 逐项进度 → 取消 → 两条**诚实的撤回**
  （「要重启 DSH 才生效」/「只恢复配置文件到装前」）。POST 入口一个没改，只新增字段
  （`state.items[].status` / `progress.items[].label`）—— 纯加字段，不改签名。
  对外文案**改说真话**：原来写"只读 / 永不执行"，现在明说页面能装、**不点确认一个字都不动**、
  插件装完要重启 DSH 才会在侧边栏出现；安全边界也直说"它挡不住以同一本地用户身份跑的其他程序"。
- **自足 Windows exe 分发物**（`npm run build:exe` → `dist/dsh-butler-install-<ver>-win-x64.exe`，约 89 MB）：
  `scripts/build-exe.mjs` 把 `scripts/sea-entry.mjs` 用 esbuild 打成单文件 CJS → Node SEA 出 blob →
  postject 注入本机 `node.exe` 的副本。**自带运行时**（连 node 不在 PATH 也能出界面）：环境体检
  （dsh / npm 在不在）→ 探测已有向导页 → 起页面 → 自动开浏览器 → 关掉窗口就停；清单内嵌，
  不依赖仓里那份 `suite-manifest.json`。`dist/` 进 `.gitignore`（走网盘分发，不撑仓；**构建链入仓**）。
  `probeExistingUi` / `openBrowser` 挪到 `lib/ui-probe.mjs`，bin 只再导出，**行为不变**。
- **失败输出加「人话环境归因」**（新件 `lib/explain-failure.mjs`，纯函数：不 spawn、不读盘、无网络）：
  安装/卸载命令失败时，原始 stderr **原样保留**，后面**追加**一段人话 ——
  ① `blocked-symlink`：安全软件（360 / EDR）拦了 pnpm 建符号链接（`EPERM … symlink` 同行，或栈里有
  `registerProject`）⇒ 放行 / 换数据根 / 重试三选一；② `store-mismatch`：`ERR_PNPM_UNEXPECTED_STORE`
  ⇒ 用回原来那处 store / 在该 profile 重装 / 换干净数据根；③ `unknown-pnpm`：认得出是 pnpm 的错但码没收录
  ⇒ 给原码让用户带走。**认不出来返回 `null`，一个字都不加**（不猜）。归因只做展示，不参与判据、不改退出码。
  终端三行缩进 4 格（不进进度事件），另发一条摘要行给 `--ui` / exe 的页面 lines + 失败项详情。
- **退出码写人话**：Windows 上无符号退出码（如 `4294963248`）追加等价写法
  `（= -4048，0xFFFFF030）`，原始数值永远在最前面（可解析性不丢）。常规退码（0/1/3/4…）一个字符不改。

### Fixed

- **挂载判据把"子包路径挂载"判成没挂（memory-toolkit 装完必被判失败并回滚）**：`--dump-config` 里
  `name: '@kira905/dsh-memory-toolkit/dsh-memory-local'` 是子包路径挂载（正常形态），旧判据只认
  `name === 包名` ⇒ 命中 0 条 ⇒ 每轮装完自检红、就地回滚，用户照清单永远装不上。
  现在命中条件 = **精确相等 或 `<包名>/` 前缀**（`/` 是硬边界：`@s/dsh-foo` 不会命中包 `@s/dsh-foobar`，反之亦然）。
- **"同一实现挂两次"的防线改成逐 name 数次数**：原来靠"命中条目恰好 1 条"隐含兜着，现在单独判
  「每个命中 name 在整棵树里恰好 1 次」并保留「每个 id 恰好 1 次」⇒ 一个包有意识地挂多个内部模块
  （各 name 各 1 次）判通过，同一个 name 出现两次仍判红。
- 挂载通过时的说明文案改为按实际读数报「条目 N 条（name 列表）」，不再写死"1 条"。

## [0.2.1] - 2026-10-31

> 本版**已发布到 npm**（`latest = 0.2.1`）。它是 0.2.0 的清单修复重发：0.2.0 带的清单把 5 个组件钉在
> 发布前的旧区间上，一条命令装出来的是旧一套，**而且装后自检照样绿**（自检读同一份清单、同样认为旧版本
> 符合期望）—— 自己核自己，永远绿。本版换上新清单，并附一条能对 registry 现跑的区间判据。

### Fixed

- **清单 5 项版本区间漂移**：`dsh-ecosystem-panel` / `dsh-butler-archive` / `dsh-memory-toolkit` /
  `dsh-butler-core` / `dsh-quality-toolkit` 的 `versionRange` 停在写清单那天，之后这 5 个包各跳了
  一个小版本（0.x 阶段里这就是大版本），caret 的上界把新版挡在门外 ⇒ 照旧清单装一遍拿到的是
  发布前的旧一套，而且**装后自检照样绿**（它读同一份清单、同样认为旧版本符合期望）。区间已刷到
  各包当前 latest：`^0.5.0` / `^0.4.0` / `^0.2.0` / `^0.3.0` / `^0.2.0`。
- **`dsh-memory-toolkit` 的 note 据实改写**：0.2.0 起主包自己带 `dsh.bundle`，本项按「必须挂载」判；
  旧 note 说"带正确声明的版本发布后，这个区间会自动接受它"是错的 —— `0.1.x → 0.2.0` 跨小版本，
  caret 不会自动接受，想变绿只能改区间。

### Added

- **`test/range-drift.mjs`：清单区间 vs npm latest 的漂移判据**。一条命令对清单逐项判「区间还接不接受
  registry 上的 latest」，逐项打印 + 汇总；退出码 `0` 全绿 / `3` 有漂移 / `4` 取数失败（**不当通过**）/
  `2` 用法错。取数两条路：缺省 `npm view <pkg> version`（真网络），或 `--offline <json>` 读快照
  （零网络，夹具用）。已接进 `test/run-all.mjs`（那一格零网络）。附取数快照
  `test/fixtures/npm-latest-snapshot.json`（带 `capturedAt`，刷新时必改）。

## [0.2.0] - 2026-10-30

> 本版只落仓，**未发 npm / 未打 tag**（发布统一在下一批做）。
>
> 补注（2026-10-31）：0.2.0 已在后续批次发布到 npm（`latest = 0.2.0`）；上面这行是当日落仓时的事实。

### Added

- **`--ui`：挂在 DSH 外面的只读本地向导页**（`--ui` / `--ui --port <n>`）。起一个只绑
  `127.0.0.1` 的本地 HTTP 服务，页面是清单表：每行给出包名 / 类型 / 未装·已装 / 实体版本 / 期望区间，
  两个按钮分别是「复制命令」（复制的是 `--dry-run` 会打印的**同一行**，同一函数产出）与
  「重查」（只重跑探测，不改任何状态）。默认端口 45080，被占自动往后挑并打印实际地址。
  - **只有两个 `GET`**：`GET /` 与 `GET /state`；其余方法一律 **405 + `Allow: GET`**，其余路径 404。
  - **服务端零执行**：没有任何写入口，不跑 `dsh` / `npm`；启动时只做一次只读的
    `npm config get prefix`，之后每个请求零 spawn。
  - 「按顺序」只写**建议顺序 + 为什么这么建议**，并明说组件之间没有代码依赖 ——
    不写"必须按 1→2→3 才能成功"这种假仪式。
  - 为什么不做成插件侧边栏页（要装插件 + 写 `cordis.patch.yml` + 重启、DSH 升级可能崩、
    装 DSH 之前用不了）：见 README 那张对照表。
- `--port <n>`：向导页端口（离开 `--ui` 使用会报用法错误，退出码 2）。

### Changed

- 把「清单 → 选中 → 现状 → 每项要跑的命令」抽成 `lib/plan.mjs` 单层（唯一出产地）：
  `--dry-run` 的文本与 `GET /state` 的 JSON 都是它的渲染，**不给 `--ui` 时输出逐字节不变**
  （夹具用改动前的原始输出做金标，plain / `--json` / `--only` 三档逐字节对照）。

### Security

- 监听地址写死 `127.0.0.1`（无环境变量开关，`assertLoopbackHost()` 对任何非环回地址当场抛错）；
  变异测试把地址改成 `0.0.0.0` 时夹具必须变红。

## [0.1.0] - 2026-10-30

### Added

- **薄壳安装器** `dsh-butler-install`：按清单逐包调用官方的两条原语
  （`dsh plugin --profile <p> add|remove`、`npm i -g|npm rm -g`），装完逐项核对，
  任一步失败即回滚。默认演练档（零执行、零写入），真装要显式 `--apply`。
- **清单** `suite-manifest.json`：16 项（5 插件 + 11 命令行），每项写
  包名 / 期望版本**区间** / 类型 / 组名 / 探针类型；另含 `excluded` 段说明
  「不是可安装包」的历史聚合目录。安装器与将来的装后自检共用这一份。
- **三步判据**：包实体在位（探针）/ 实体版本落在期望区间 / 插件真的进了组合列表
  —— 组合树里按"组合头恰好 1 行、条目 name 恰好 1 条、该 id 在整棵树里恰好 1 次"数次数，
  因为撞 id 时宿主不报错、只多打一行。
- **探针三种**：`existence`（默认，只查文件在不在、一条命令都不跑）/ `help`
  （**执行前先静态核源码确有 `--help` 分支**，核不到就拒跑）/ `cmd`（清单指定的只读命令，
  必须写明凭什么认定只读）。
- **两级回滚**：`--rollback`（默认，只退失败那一步）/ `--rollback=batch`（退整批）；
  快照拍声明层文件（`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` /
  `pnpm-workspace.yaml`），开跑前一份、每成功一步一份；回滚后按 sha256 重核。
- **退出码三档**：`0` 全绿 / `3` 失败但已回滚干净 / `4` 失败且回滚不干净（要人看）。
- **只读取证工具** `dsh-butler-install-probe-scan`：扫包的 `bin` 源文件，逐个命令回答
  「它到底有没有实现 `--help`」，一个命令都不执行。
- **夹具** 151 条断言：清单校验（每条错误带文件名 + 行号）/ 版本区间三态 / 探针三分支 /
  组合树三条计数判据各自独立可触发 / 快照回放 / 演练档零副作用 / 退出码 0·3·4 /
  步级与整批回滚 / 卸载；另跑过 5 处变异测试（改坏判据必红、还原必绿）。
