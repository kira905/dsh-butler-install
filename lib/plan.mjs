/**
 * 计划层 = 「清单 → 选中 → 现状 → 每项要跑的命令」的**唯一**出产地。
 *
 * 为什么要有这一层（2026-10-30 加 --ui 时抽出来的）：
 * 向导页与 `--dry-run` 必须说同一句话。只要"页面自己拼一行命令"存在，两者迟早漂移，
 * 而漂移的后果是用户复制到的那行**不是**安装器真正会跑的那行 —— 这类假一致比没有界面更坏。
 * 所以命令字符串只在这里生成一次（`formatCommandLine` + `installStepFor`），
 * 文本演练（lib/run.mjs）与 JSON（GET /state）都只做"渲染"，不做"拼接"。
 *
 * 本层是**纯读**：读清单、读 profile/全局前缀里的文件、扫 PATH。唯一可能起进程的是
 * `npm config get prefix`（见 lib/state.mjs，只读且失败可回退）；`--ui` 会在启动时解析一次
 * 再传进来（见 options.npmResolved），于是**每个请求零 spawn**。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, formatManifestError, describeItem } from './manifest.mjs';
import { satisfies, parseRange, describeRange } from './semver.mjs';
import {
  resolveHome,
  readProfile,
  profileInstalledVersion,
  globalInstalledVersion,
  resolveNpmPrefix,
  findExistingBin,
  findOnPath,
  readInstalledDshDecl,
} from './state.mjs';
import { formatCommandLine } from './exec.mjs';
import { detectDesktop, desktopMissingHelp } from './desktop.mjs';
import { createRegistryResolver } from './registry.mjs';
import { EXIT } from './cli-args.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MANIFEST = path.join(PKG_ROOT, 'suite-manifest.json');

export function shortName(name) {
  const parts = String(name).split('/');
  return parts[parts.length - 1];
}

/** 按 --only / --skip 选条目；组名、包名、短名、别名都认 */
export function selectItems(manifest, { only = [], skip = [] } = {}) {
  const items = manifest.items;
  const errors = [];
  const groups = [...new Set(items.map((i) => i.group))];
  const resolve = (token) => items.filter((i) => (
    i.name === token
    || shortName(i.name) === token
    || i.group === token
    || (Array.isArray(i.aliases) && i.aliases.includes(token))
  ));

  let selected = items.slice();
  if (only.length) {
    const picked = new Set();
    for (const token of only) {
      const hits = resolve(token);
      if (!hits.length) {
        errors.push(`--only 里的 ${JSON.stringify(token)} 没匹配到任何条目（可选组：${groups.join(' / ')}；也可以直接写包名或别名）`);
        continue;
      }
      for (const h of hits) picked.add(h.name);
    }
    selected = items.filter((i) => picked.has(i.name));
  }

  const dropped = new Set();
  for (const token of skip) {
    const hits = resolve(token);
    if (!hits.length) errors.push(`--skip 里的 ${JSON.stringify(token)} 没匹配到任何条目`);
    for (const h of hits) dropped.add(h.name);
  }

  return { items: selected.filter((i) => !dropped.has(i.name)), errors, groups };
}

export function installStepFor(item, { profile, npmPrefix, dshCli }) {
  // 装的时候把**清单里的期望区间**一起点名（`<包>@^x.y.z`）。
  // 为什么必须带上：不带区间时拿到的是注册表 `latest` 标签指的那个版本，而它未必在
  // 我们期望的区间里（实测踩过：latest 标签指着的版本与最高版本号不是一回事）。
  // 带区间 = 让解析器只能落进期望区间，落不进去就报错，而不是"装了个别的版本还报成功"。
  // ⚠️ 这个 `^` 必须原样到 npm/dsh 手里：lib/exec.mjs 已不再过 shell（cmd 会吃掉 `^`）。
  const spec = `${item.name}@${item.versionRange}`;
  if (item.type === 'plugin') {
    // 桌面版（Electron）的 profile 只能用它自带的 dsh.cmd 改；为 null 时才用 PATH 上的 dsh
    return { file: dshCli || 'dsh', args: ['plugin', '--profile', profile, 'add', spec], env: {} };
  }
  return { file: 'npm', args: ['i', '-g', spec], env: npmPrefix ? { npm_config_prefix: npmPrefix } : {} };
}

export function uninstallStepFor(item, { profile, npmPrefix, dshCli }) {
  if (item.type === 'plugin') {
    return { file: dshCli || 'dsh', args: ['plugin', '--profile', profile, 'remove', item.name], env: {} };
  }
  return { file: 'npm', args: ['rm', '-g', item.name], env: npmPrefix ? { npm_config_prefix: npmPrefix } : {} };
}

/** 判定某一项"现在是否已满足"，纯读文件 */
export function assessItem(item, ctx, profile, { upgrade = false } = {}) {
  const mount = item.mount || (item.type === 'plugin' ? 'auto' : 'none');
  if (item.type === 'plugin') {
    const version = profileInstalledVersion(ctx.home, ctx.profile, item.name);
    const depDeclared = Object.prototype.hasOwnProperty.call(profile.deps || {}, item.name);
    const bundleRegistered = (profile.bundles || []).includes(item.name);
    const range = version ? satisfies(item.versionRange, version) : 'no';
    const decl = readInstalledDshDecl(ctx.home, ctx.profile, item.name);
    // 该不该进组合列表：**以包实体的声明为准**。本版没声明 bundle 的包，
    // 不登记也是正确状态（登记反而是空的），所以这里不拿"没登记"判它未满足。
    const mountOk = mount !== 'auto' || bundleRegistered || !decl.hasBundle;
    const satisfied = Boolean(version) && depDeclared && mountOk && (range === 'yes' || range === 'unknown');
    return {
      item,
      type: 'plugin',
      mount,
      version,
      depDeclared,
      bundleRegistered,
      range,
      satisfied,
      action: satisfied && !upgrade ? 'skip' : 'install',
    };
  }
  const version = globalInstalledVersion(ctx.npmPrefix, item.name);
  const binFile = item.probe && item.probe.cmd
    ? findExistingBin({ cmd: item.probe.cmd, home: ctx.home, profile: ctx.profile, npmPrefix: ctx.npmPrefix })
    : null;
  const range = version ? satisfies(item.versionRange, version) : 'no';
  const satisfied = Boolean(version) && Boolean(binFile) && (range === 'yes' || range === 'unknown');
  return {
    item,
    type: 'cli',
    mount: 'none',
    version,
    binFile,
    range,
    satisfied,
    action: satisfied && !upgrade ? 'skip' : 'install',
  };
}

/** 每一项装完拿什么判据（演练档与向导页共用同一句话） */
export function criteriaText(item) {
  const parts = [];
  const kind = (item.probe && item.probe.kind) || 'existence';
  if (kind === 'existence') {
    parts.push(item.type === 'plugin'
      ? `profile 的 node_modules/${item.name}/package.json 存在（只查文件，不执行）`
      : `命令文件 ${item.probe.cmd} 在 .bin 或全局前缀下存在（只查文件，不执行）`);
  } else if (kind === 'help') {
    parts.push(`先静态核 ${item.probe.cmd} 源码里确有 --help 分支，再跑 ${item.probe.cmd} --help`);
  } else {
    parts.push(`跑 ${item.probe.cmd} ${(item.probe.argv || []).join(' ')}（清单声明只读：${item.probe.readonlyBecause}）`);
  }
  parts.push(`实体版本落在 ${describeRange(parseRange(item.versionRange))} 内，且不落后于注册表上该区间内的最高合规版（取不到注册表时单列"未核"，不冒充通过）`);
  if (item.type === 'plugin' && (item.mount || 'auto') === 'auto') {
    parts.push('dump-config 里组合头恰好 1 行、条目 name 恰好 1 条、该 id 在整棵树里恰好 1 次');
  }
  if (item.type === 'plugin' && item.mount === 'manual') {
    parts.push('挂载不判（本包按设计不进组合列表）');
  }
  return parts.join(' · ');
}

/**
 * 「建议顺序」= 阅读/排查顺序，**不是**技术依赖（方案 §5.3 的硬口径）。
 * 组名 → 为什么建议排在这。没写到的组用兜底理由，绝不编一个假依赖出来。
 */
const GROUP_ORDER_WHY = {
  核心: '先装面板：后面装的东西对不对，靠它看。',
  界面: '界面增强，彼此之间没有先后，装完刷新页面就能看到。',
  记忆: '它要占"记忆"这个位置，与官方记忆插件二选一；建议单独一步，装完自己确认组合列表里没有官方那份。',
  CLI: '纯命令行工具，可以最后一批装。装完用"命令文件在不在"验，不跑 --help —— 这批命令里有不少会把未知参数当普通参数、照常干活。',
  体检: '体检 / 急救类命令，最后装也行；平时用不到它们，不影响前几类。',
};

const ORDER_FALLBACK_WHY = '与其它组之间没有代码依赖，什么时候装都行；这里只是建议顺序。';

export const ORDER_NOTES = [
  '真正的技术顺序只有三格：Node ≥22 → dsh 主包 → profile（首次 `dsh plugin` 会自动建）→ 各组件。',
  '组件之间没有代码依赖：谁先谁后都能装上。下面给的是**建议顺序 + 为什么这么建议** —— 换句话说，这里的"顺序"是给人看的排查路径，不是成功的前提。',
];

function buildOrder(groups, items) {
  const out = [];
  for (const group of groups) {
    const inGroup = items.filter((i) => i.group === group);
    if (!inGroup.length) continue;
    out.push({
      step: out.length + 1,
      group,
      why: GROUP_ORDER_WHY[group] || ORDER_FALLBACK_WHY,
      items: inGroup.map((i) => i.name),
    });
  }
  return out;
}

/**
 * 桌面版探测结果缓存（键 = 数据根 + 两个显式环境变量）。
 * 为什么必须缓存：向导页的 GET /state 每个请求都会走 buildSuiteState，而探测要扫盘、
 * 必要时还要起一个 PowerShell 反查进程 —— 不缓存的话打开页面就会卡住。
 */
const desktopDetectCache = new Map();

/** 夹具用：换一套伪造环境之前把缓存清掉 */
export function resetDesktopDetectCache() {
  desktopDetectCache.clear();
}

async function desktopFor(home, options) {
  const env = options.env || process.env;
  const key = `${home}|${env.DSH_DESKTOP_DIR || ''}|${env.DSH_DESKTOP_CLI || ''}`;
  if (desktopDetectCache.has(key)) return desktopDetectCache.get(key);
  const detected = await detectDesktop({
    home,
    env,
    run: options.desktopRun,
    allowProcessProbe: options.allowProcessProbe,
    // 夹具用：直接把候选安装目录钉死，免得本机真装了桌面版时测试跟着本机走
    roots: options.desktopRoots,
    platform: options.platform,
  });
  desktopDetectCache.set(key, detected);
  return detected;
}

/**
 * 这次到底对哪个 profile 动手。
 *
 * 三条判据（按顺序）：
 *  ① 显式 `--profile desktop` 但本机找不到桌面版自带命令 ⇒ **硬拒绝**（rc=2）。
 *     为什么不能"退回去用 CLI 版试试"：宿主会回 `profile "desktop" is managed exclusively
 *     by the Electron application`，我们只会给用户一个看不懂的报错。
 *  ② 用户没亲手点名 profile（--ui 的默认 web）、**数据根里有桌面版自建的 desktop profile**
 *     且这里压根没有 web profile ⇒ 切 desktop。为什么要求"有 desktop profile"：本机同时
 *     装着 CLI 版和桌面版是常态，光看"能不能找到桌面版安装目录"就切，会把 CLI 用户的活
 *     搬进桌面版 profile —— 那才是真事故。
 *  ③ 用户明确要 web 而机器上有桌面版 ⇒ 只提示、不阻断（同机双装是合法状态）。
 */
export function decideProfile({ options, home, desktop }) {
  const requested = options.profile;
  const notices = [];
  if (requested === 'desktop') {
    if (!desktop.cliCmd) {
      return { profile: requested, changed: false, source: 'explicit', notices, error: desktopMissingHelp(home) };
    }
    return { profile: requested, changed: false, source: 'explicit', notices };
  }
  if (!options.profileExplicit) {
    const webExists = readProfile(home, 'web').exists;
    if (desktop.desktopProfileExists && desktop.cliCmd && !webExists) {
      notices.push('这台机器的数据根里只有桌面版自建的 desktop profile（没有 web），已改成 --profile desktop —— 装进 web 的那套界面桌面版永远不加载');
      return { profile: 'desktop', changed: true, source: 'auto-desktop', notices };
    }
  }
  if (requested === 'web' && desktop.detected && desktop.cliCmd) {
    notices.push('这台机器上有桌面版：如果你其实是在用它，--profile web 装上去不会加载（web 是 `dsh web` 那套的）；桌面版请用 --profile desktop');
  }
  return { profile: requested, changed: false, source: options.profileExplicit ? 'explicit' : 'default', notices };
}

/**
 * 唯一入口：产出「这次会做什么」的全部数据（文本演练与 /state 共用）。
 *
 * @param {object} options  与 CLI 选项同形（至少 profile / manifest / only / skip / upgrade / home / npmPrefix）
 * @param {object} [pre]    `{ npm }`：已解析好的全局前缀，传了就不再 spawn（--ui 用它保证每请求零 spawn）
 * @returns {Promise<{ok:boolean, exitCode:number, log:string[], summary:object, plan?:Array, state?:object}>}
 */
export async function buildSuiteState(options, pre = {}) {
  const log = [];
  const say = (text = '') => log.push(text);
  const summary = {
    mode: options.uninstall ? 'uninstall' : options.apply ? 'apply' : 'dry-run',
    profile: options.profile,
    home: null,
    npmPrefix: null,
    manifest: null,
    items: [],
    warnings: [],
    excluded: [],
    rollback: null,
    exitCode: null,
  };
  const fail = (exitCode, errors) => ({ ok: false, exitCode, log, summary, errors: errors || log.slice() });

  // ── 1. 清单 ────────────────────────────────────────────────
  const manifestPath = options.manifest || DEFAULT_MANIFEST;
  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (err) {
    say(formatManifestError(err, path.basename(manifestPath)));
    summary.exitCode = EXIT.USAGE;
    return fail(EXIT.USAGE);
  }
  summary.manifest = manifest.path;
  summary.excluded = manifest.excluded.map((e) => ({ id: e.id, reason: e.reason }));

  // ── 2. 选条目 ──────────────────────────────────────────────
  const selection = selectItems(manifest, options);
  if (selection.errors.length) {
    for (const e of selection.errors) say(`✖ ${e}`);
    summary.exitCode = EXIT.USAGE;
    return fail(EXIT.USAGE);
  }
  if (!selection.items.length) {
    say('✖ 选完之后没有任何条目可做（检查 --only / --skip）');
    summary.exitCode = EXIT.USAGE;
    return fail(EXIT.USAGE);
  }

  // ── 3. 上下文 ──────────────────────────────────────────────
  const home = resolveHome(options.home);
  // 桌面版（Electron）识别：它自建 profiles/desktop，而且只有它**自带**的命令改得动那个 profile。
  // 探测结果按 home 缓存（向导页每个请求都会走到这里，不能每次都扫盘/起 PowerShell）。
  const desktop = await desktopFor(home, options);
  const decision = decideProfile({ options, home, desktop });
  if (decision.error) {
    for (const line of decision.error.split('\n')) say(line);
    summary.exitCode = EXIT.USAGE;
    return fail(EXIT.USAGE);
  }
  // 写回 options：--ui 的预览与真装是两个调用，profile 必须在同一个值上，
  // 否则"预览说装 desktop、真装却写到 web"（这条写回是**有意的副作用**）。
  options.profile = decision.profile;
  const profileName = decision.profile;
  const profile = readProfile(home, profileName);
  const npm = pre.npm || await resolveNpmPrefix(options.npmPrefix);
  const ctx = {
    home,
    profile: profileName,
    npmPrefix: npm.prefix,
    // 桌面版自带命令**只对 desktop 这个 profile 有效**：桌面版只管它自己那个 profile，
    // web/profile 还是得用 PATH 上的 CLI 版。拿桌面命令去改别的 profile = 越权，必错。
    dshCli: profileName === 'desktop' ? (desktop.cliCmd || null) : null,
    // 注册表核对器（惰性：只有真正跑判据时才联网；演练档一条都不查）
    registry: createRegistryResolver({
      enabled: !options.noRegistry,
      snapshot: options.registrySnapshot || null,
      run: options.registryRun,
      npmCommand: options.npmCommand || 'npm',
    }),
  };
  summary.home = home;
  summary.npmPrefix = npm.prefix;
  summary.profileSource = decision.source;

  say(`清单：${manifest.path}`);
  say(`共 ${manifest.items.length} 项，本次选中 ${selection.items.length} 项（组：${[...new Set(selection.items.map((i) => i.group))].join(' / ')}）`);
  say(`数据根：${home}`);
  say(`profile：${profileName}（${profile.exists ? '已存在' : '尚不存在，真装时由宿主自动创建'}）${decision.changed ? ' —— 桌面版环境自动选的（原值 web 在桌面版上永远不加载）' : ''}`);
  if (ctx.dshCli) {
    // 只有"这次就要用桌面版自带命令"时才多打这一行：本机同时装着桌面版是常态，
    // 动不动就提一句会污染 --ui 与 CLI 逐字节一致的那条金标（见 test-ui.mjs）。
    say(`桌面版：认出是 Electron 版，用它的自带命令 ${desktop.cliCmd} 改 profile ${profileName}`);
  }
  for (const notice of decision.notices) say(`ℹ ${notice}`);
  say(`全局包落点：${npm.prefix}（来源：${npm.source}）`);
  if (manifest.excluded.length) {
    for (const entry of manifest.excluded) {
      say(`⏭ 不可安装项 ${entry.id}：${entry.reason}`);
    }
  }
  say('');

  // 前置：dsh 与 npm 两条原语都得在（只查文件存在，不执行）
  const dshPath = ctx.dshCli || findOnPath('dsh') || findExistingBin({ cmd: 'dsh', home, profile: profileName, npmPrefix: npm.prefix });
  const npmPath = findOnPath('npm');
  const preflight = [];
  if (!dshPath) preflight.push('找不到 dsh 命令（PATH 与全局前缀两处都查过）⇒ 插件类无从安装，也无法核对挂载');
  if (!npmPath) preflight.push('找不到 npm 命令 ⇒ 命令行类无从安装');

  // ── 4. 计划 ────────────────────────────────────────────────
  const plan = selection.items.map((item) => assessItem(item, ctx, profile, { upgrade: options.upgrade }));
  // 命令字符串只在这里生成一次：演练文案与 /state 都是它的渲染，不许别处再拼一遍
  for (const entry of plan) {
    const installStep = installStepFor(entry.item, { profile: profileName, npmPrefix: npm.prefix, dshCli: ctx.dshCli });
    const uninstallStep = uninstallStepFor(entry.item, { profile: profileName, npmPrefix: npm.prefix, dshCli: ctx.dshCli });
    entry.command = formatCommandLine(installStep.file, installStep.args);
    entry.commandUninstall = formatCommandLine(uninstallStep.file, uninstallStep.args);
    entry.criteria = criteriaText(entry.item);
  }
  summary.items = plan.map((p) => ({
    name: p.item.name,
    type: p.item.type,
    group: p.item.group,
    mount: p.mount,
    installedVersion: p.version,
    inRange: p.range,
    satisfied: p.satisfied,
    action: p.action,
  }));

  const toInstall = plan.filter((p) => p.action === 'install');
  const skipped = plan.filter((p) => p.action === 'skip');

  if (!options.uninstall) {
    say(`建议顺序（组件之间没有代码依赖，"顺序"只是排查建议）：先装面板 → 界面增强 → 记忆 → 命令行工具一批。`);
    say('');
  }

  // ── 5. 给渲染层用的结构化快照（/state 就是它，加字段只加在这里） ─────
  const items = plan.map((entry, index) => {
    const d = describeItem(entry.item);
    return {
      step: index + 1,
      name: d.name,
      shortName: shortName(d.name),
      type: d.type,
      group: d.group,
      mount: d.mount,
      versionRange: entry.item.versionRange,
      rangeText: d.rangeText,
      aliases: Array.isArray(entry.item.aliases) ? entry.item.aliases : [],
      note: typeof entry.item.note === 'string' ? entry.item.note : '',
      installed: Boolean(entry.version),
      installedVersion: entry.version,
      inRange: entry.range,
      satisfied: entry.satisfied,
      action: entry.action,
      probeKind: d.probeKind,
      // 已满足的项 CLI 什么都不跑（不加 --upgrade 时）⇒ 命令就是 null，页面也就复制不到假命令
      command: entry.action === 'install' ? entry.command : null,
      commandUninstall: entry.commandUninstall,
      criteria: entry.action === 'install' ? entry.criteria : null,
    };
  });

  const state = {
    ok: true,
    exitCode: EXIT.OK,
    generatedAt: new Date().toISOString(),
    mode: summary.mode,
    suite: manifest.meta && manifest.meta.suite ? manifest.meta.suite : null,
    manifest: manifest.path,
    home,
    profile: profileName,
    profileSource: decision.source,
    profileExists: profile.exists,
    // 桌面版（Electron）：认出来了就用它自带的命令，绝不拿 npm 装的 CLI 去改它的 profile
    desktop: {
      detected: Boolean(desktop.detected),
      cliCmd: desktop.cliCmd || null,
      root: desktop.root || null,
      source: desktop.source || '',
      desktopProfileExists: Boolean(desktop.desktopProfileExists),
      evidence: Array.isArray(desktop.evidence) ? desktop.evidence.slice() : [],
    },
    // 装后判据要对着注册表核"是不是最新合规版"；这一格说清有没有核（关掉时如实标 off）
    registryCheck: options.noRegistry ? 'off' : 'on',
    npmPrefix: npm.prefix,
    npmPrefixSource: npm.source,
    upgrade: Boolean(options.upgrade),
    counts: {
      total: manifest.items.length,
      selected: selection.items.length,
      install: toInstall.length,
      skip: skipped.length,
    },
    preflight,
    excluded: summary.excluded.map((e) => ({ ...e })),
    order: buildOrder([...new Set(plan.map((p) => p.item.group))], plan.map((p) => p.item)),
    orderNotes: ORDER_NOTES.slice(),
    items,
  };

  return { ok: true, exitCode: EXIT.OK, log, summary, plan, state, ctx, profile, preflight, npm, toInstall, skipped };
}
