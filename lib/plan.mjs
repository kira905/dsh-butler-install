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

export function installStepFor(item, { profile, npmPrefix }) {
  // 装的时候把**清单里的期望区间**一起点名（`<包>@^x.y.z`）。
  // 为什么必须带上：不带区间时拿到的是注册表 `latest` 标签指的那个版本，而它未必在
  // 我们期望的区间里（实测踩过：latest 标签指着的版本与最高版本号不是一回事）。
  // 带区间 = 让解析器只能落进期望区间，落不进去就报错，而不是"装了个别的版本还报成功"。
  const spec = `${item.name}@${item.versionRange}`;
  if (item.type === 'plugin') {
    return { file: 'dsh', args: ['plugin', '--profile', profile, 'add', spec], env: {} };
  }
  return { file: 'npm', args: ['i', '-g', spec], env: npmPrefix ? { npm_config_prefix: npmPrefix } : {} };
}

export function uninstallStepFor(item, { profile, npmPrefix }) {
  if (item.type === 'plugin') {
    return { file: 'dsh', args: ['plugin', '--profile', profile, 'remove', item.name], env: {} };
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
  parts.push(`实体版本落在 ${describeRange(parseRange(item.versionRange))}`);
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
  const profile = readProfile(home, options.profile);
  const npm = pre.npm || await resolveNpmPrefix(options.npmPrefix);
  const ctx = { home, profile: options.profile, npmPrefix: npm.prefix };
  summary.home = home;
  summary.npmPrefix = npm.prefix;

  say(`清单：${manifest.path}`);
  say(`共 ${manifest.items.length} 项，本次选中 ${selection.items.length} 项（组：${[...new Set(selection.items.map((i) => i.group))].join(' / ')}）`);
  say(`数据根：${home}`);
  say(`profile：${options.profile}（${profile.exists ? '已存在' : '尚不存在，真装时由宿主自动创建'}）`);
  say(`全局包落点：${npm.prefix}（来源：${npm.source}）`);
  if (manifest.excluded.length) {
    for (const entry of manifest.excluded) {
      say(`⏭ 不可安装项 ${entry.id}：${entry.reason}`);
    }
  }
  say('');

  // 前置：dsh 与 npm 两条原语都得在（只查文件存在，不执行）
  const dshPath = findOnPath('dsh') || findExistingBin({ cmd: 'dsh', home, profile: options.profile, npmPrefix: npm.prefix });
  const npmPath = findOnPath('npm');
  const preflight = [];
  if (!dshPath) preflight.push('找不到 dsh 命令（PATH 与全局前缀两处都查过）⇒ 插件类无从安装，也无法核对挂载');
  if (!npmPath) preflight.push('找不到 npm 命令 ⇒ 命令行类无从安装');

  // ── 4. 计划 ────────────────────────────────────────────────
  const plan = selection.items.map((item) => assessItem(item, ctx, profile, { upgrade: options.upgrade }));
  // 命令字符串只在这里生成一次：演练文案与 /state 都是它的渲染，不许别处再拼一遍
  for (const entry of plan) {
    const installStep = installStepFor(entry.item, { profile: options.profile, npmPrefix: npm.prefix });
    const uninstallStep = uninstallStepFor(entry.item, { profile: options.profile, npmPrefix: npm.prefix });
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
    profile: options.profile,
    profileExists: profile.exists,
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
