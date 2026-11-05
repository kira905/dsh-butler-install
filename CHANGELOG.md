# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

（暂无）

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
