/**
 * 安装器的编排层：清单 → 计划 → （演练 | 执行）→ 判据 → 失败回滚。
 *
 * 三条写死的边界（改这个文件之前先读一遍）：
 *  1. 只用两个原语：`dsh plugin --profile <p> add|remove …` 与 `npm i -g|npm rm -g …`；
 *     本文件里**没有**任何"自己下载、自己解包、自己写组合列表"的路径。
 *  2. 判定不靠记账、靠当场核对：每一步跑完立刻看文件（包实体 / 区间 / 组合树），
 *     不看"我以为它装过了"。
 *  3. 退出码只有三档有意义：0 全绿 / 3 失败但回滚干净 / 4 失败且回滚不干净。
 */
import path from 'node:path';
import { describeItem } from './manifest.mjs';
import { satisfies } from './semver.mjs';
import {
  readProfile,
  profileInstalledVersion,
  globalInstalledVersion,
  findExistingBin,
  readInstalledDshDecl,
} from './state.mjs';
import { runProbe } from './probe.mjs';
import { analyzeDump, checkMounted, skippedBundlesFromStderr } from './dump.mjs';
import { takeSnapshot, restoreSnapshot, verifySnapshotRestored, SNAPSHOT_WARNING } from './snapshot.mjs';
import { spawnCommand, formatCommandLine } from './exec.mjs';
import { EXIT } from './cli-args.mjs';
import {
  DEFAULT_MANIFEST,
  selectItems,
  installStepFor,
  uninstallStepFor,
  assessItem,
  criteriaText,
  buildSuiteState,
} from './plan.mjs';

// 「清单 → 选中 → 现状 → 每项要跑的命令」这一层搬去了 lib/plan.mjs（--ui 的 GET /state 与这里同源）。
// 这几个名字老早就在本文件里导出过，夹具也在用，所以在这儿原样再导出，别改 import 路径。
export { EXIT, DEFAULT_MANIFEST, selectItems, installStepFor, uninstallStepFor, assessItem, criteriaText };

function firstLine(text) {
  return String(text || '').trim().split(/\r?\n/)[0] || '';
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}


function execEnv(ctx, extra) {
  return { DSH_HOME: ctx.home, ...(extra || {}) };
}

/** 这个包现在还在这台机的任何一处吗（声明层或实体层）—— 决定回滚时要不要去卸它 */
function isPresentAnywhere(item, ctx) {
  if (item.type === 'plugin') {
    const profile = readProfile(ctx.home, ctx.profile);
    if (Object.prototype.hasOwnProperty.call(profile.deps || {}, item.name)) return true;
    if ((profile.bundles || []).includes(item.name)) return true;
    return Boolean(profileInstalledVersion(ctx.home, ctx.profile, item.name));
  }
  if (globalInstalledVersion(ctx.npmPrefix, item.name)) return true;
  const cmd = item.probe && item.probe.cmd;
  return Boolean(cmd && findExistingBin({ cmd, home: ctx.home, profile: ctx.profile, npmPrefix: ctx.npmPrefix }));
}

let dumpCache = null;
function invalidateDump() {
  dumpCache = null;
}

async function getDumpAnalysis(ctx) {
  if (dumpCache) return dumpCache;
  const res = await spawnCommand('dsh', ['--profile', ctx.profile, '--dump-config'], {
    timeoutMs: 10000,
    env: execEnv(ctx),
    quiet: true,
  });
  if (res.timedOut) {
    dumpCache = { ok: false, reason: '--dump-config 超时（10s）⇒ 挂载判据记"未知"，不当通过、也不报红' };
    return dumpCache;
  }
  if (res.code !== 0) {
    dumpCache = {
      ok: false,
      reason: `--dump-config 退出码 ${res.code}：${firstLine(res.stderr) || '（无输出）'} ⇒ 挂载判据记"未知"`,
    };
    return dumpCache;
  }
  dumpCache = {
    ok: true,
    analysis: analyzeDump(res.stdout),
    skipped: skippedBundlesFromStderr(res.stderr),
  };
  return dumpCache;
}

function rangeStatus(range, version) {
  if (!version) return { status: 'fail', detail: '未安装' };
  if (range === 'yes') return { status: 'pass', detail: `实体 ${version}，落在期望区间内` };
  if (range === 'unknown') return { status: 'skip', detail: `实体 ${version}，带预发布后缀 ⇒ 不判合不合规（三态里的"无法比较"）` };
  return { status: 'fail', detail: `实体 ${version}，不在期望区间内` };
}

/** 一步跑完之后的判据：探针 + 版本区间 + 挂载（插件且声明自动挂载时） */
export async function verifyItem(item, ctx) {
  const mount = item.mount || (item.type === 'plugin' ? 'auto' : 'none');
  const checks = [];

  const probeResult = await runProbe(item, ctx);
  checks.push({ label: `探针（${(item.probe && item.probe.kind) || 'existence'}）`, ...probeResult });

  const version = item.type === 'plugin'
    ? profileInstalledVersion(ctx.home, ctx.profile, item.name)
    : globalInstalledVersion(ctx.npmPrefix, item.name);
  checks.push({ label: '版本区间', ...rangeStatus(version ? satisfies(item.versionRange, version) : 'no', version) });

  if (item.type === 'plugin') {
    if (mount === 'manual') {
      checks.push({ label: '挂载', status: 'skip', detail: '本包按设计不进 profile 的组合列表（清单 mount=manual）：挂载由它自带的部署命令完成，不由本工具判' });
    } else if (mount === 'none') {
      checks.push({ label: '挂载', status: 'skip', detail: '清单 mount=none，不参与组合列表' });
    } else {
      const dump = await getDumpAnalysis(ctx);
      const decl = readInstalledDshDecl(ctx.home, ctx.profile, item.name);
      const bundleRegistered = readProfile(ctx.home, ctx.profile).bundles.includes(item.name);
      if (!decl.hasBundle) {
        // 四格里的第 4 格：包自己没声明 bundle ⇒ 它本来就挂不上，别冤枉它，但也别算通过
        checks.push({
          label: '挂载',
          status: 'skip',
          detail: bundleRegistered
            ? '组合列表里登记了它，但这一版包实体没有 dsh.bundle 声明 ⇒ 登记是空的，摘掉或装回带声明的版本'
            : '这一版包实体不带 dsh.bundle（装成普通依赖是正确状态）；清单期望它自动挂载，等带声明的版本发布后本项会自动转为必须挂载',
        });
      } else if (!dump.ok) {
        checks.push({ label: '挂载', status: 'skip', detail: dump.reason });
      } else {
        const mounted = checkMounted(dump.analysis, item.name);
        checks.push({
          label: '挂载',
          status: mounted.ok ? 'pass' : 'fail',
          detail: mounted.ok
            ? `组合头 1 行 · 条目 1 条 · 该 id 计数 ${mounted.idCounts.join(',') || 'n/a'}`
            : mounted.problems.join('；'),
        });
        if (!mounted.ok && dump.skipped.length) {
          checks.push({ label: '挂载归因', status: 'skip', detail: `dump 的 stderr 里另有提示：${dump.skipped.slice(0, 3).join(' | ')}` });
        }
      }
    }
  }

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

function printChecks(say, checks) {
  for (const c of checks) {
    const mark = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⏭';
    say(`  ${mark} ${c.label}：${c.detail}`);
  }
}

/**
 * 主入口。返回 {exitCode, summary}。
 */
export async function runSuite(options) {
  const lines = [];
  const say = (text = '') => {
    lines.push(text);
    const stream = options.json ? process.stderr : process.stdout;
    stream.write(`${text}\n`);
  };
  // 清单 → 选中 → 现状 → 每项要跑的命令：全部在 lib/plan.mjs 里算一次。
  // 这里只负责"印人话"；`--ui` 的 GET /state 是同一份数据的另一种渲染 —— 两处必然一致。
  const built = await buildSuiteState(options);
  for (const line of built.log) say(line);

  const summary = built.summary;
  const warn = (text) => {
    summary.warnings.push(text);
    say(`⚠ ${text}`);
  };

  if (!built.ok) {
    summary.exitCode = built.exitCode;
    return { exitCode: built.exitCode, summary, text: lines.join('\n') };
  }

  const { plan, preflight } = built;
  const { toInstall, skipped } = built;
  const ctx = built.ctx;
  const home = built.ctx.home;
  const profile = built.profile;
  const npm = built.npm;

  // ── 5a. 演练：一条命令都不跑 ───────────────────────────────
  if (!options.apply) {
    say('本档 = 演练（默认 dry-run）：下面每条命令都不会被执行，只打印"将要跑什么"与"每步拿什么判据"。');
    say('');
    plan.forEach((entry, index) => {
      const d = describeItem(entry.item);
      say(`[${index + 1}/${plan.length}] ${d.group} · ${d.name}`);
      say(`  类型：${d.type}${d.mount !== 'none' ? ` · 挂载：${d.mount}` : ''} · 期望版本：${d.rangeText}`);
      say(`  现状：${entry.version ? `已装 ${entry.version}` : '未安装'}${entry.range === 'unknown' ? '（版本无法比较）' : ''}`);
      if (entry.action === 'skip') {
        say('  动作：跳过（已满足）');
      } else {
        // 命令与判据都是 lib/plan.mjs 生成那一份，这里只印，绝不另拼一遍
        say(`  动作：${options.uninstall ? '卸载' : '安装'}`);
        say(`  命令：${options.uninstall ? entry.commandUninstall : entry.command}`);
        say(`  判据：${entry.criteria}`);
      }
      say('');
    });
    say(`演练结束：将执行 ${toInstall.length} 条命令，跳过 ${skipped.length} 项（已满足）。`);
    say('加 --apply 才真跑；只想装一部分用 --only <组名/包名/别名>。');
    if (preflight.length) {
      for (const p of preflight) warn(`前置条件不满足：${p}`);
      summary.exitCode = EXIT.USAGE;
      return { exitCode: EXIT.USAGE, summary, text: lines.join('\n') };
    }
    summary.exitCode = EXIT.OK;
    return { exitCode: EXIT.OK, summary, text: lines.join('\n') };
  }

  if (preflight.length) {
    for (const p of preflight) say(`✖ ${p}`);
    summary.exitCode = EXIT.USAGE;
    return { exitCode: EXIT.USAGE, summary, text: lines.join('\n') };
  }

  // ── 5b. 卸载 ──────────────────────────────────────────────
  if (options.uninstall) {
    let failed = 0;
    for (const entry of plan) {
      const step = uninstallStepFor(entry.item, { profile: options.profile, npmPrefix: npm.prefix });
      say(`\n[${entry.item.group}] ${entry.item.name}`);
      say(`  $ ${formatCommandLine(step.file, step.args)}`);
      const res = await spawnCommand(step.file, step.args, {
        timeoutMs: options.timeoutMs,
        env: execEnv(ctx, step.env),
        onLine: (l) => say(`    ${l}`),
      });
      if (res.timedOut || res.code !== 0) {
        say(`  ❌ 卸载命令退出码 ${res.timedOut ? '超时' : res.code}`);
        failed += 1;
        continue;
      }
      invalidateDump();
      const after = assessItem(entry.item, ctx, readProfile(home, options.profile));
      const gone = after.version === null;
      say(`  ${gone ? '✅' : '❌'} 卸载核对：${gone ? '实体已不在' : `实体仍在（${after.version}）`}`);
      if (!gone) failed += 1;
    }
    summary.exitCode = failed ? EXIT.ROLLED_BACK : EXIT.OK;
    say(`\n卸载结束：${plan.length - failed} 项已卸、${failed} 项没卸干净。`);
    if (failed) say('（卸载没有"回滚"这一说：它看的是现在装着什么，不是这一轮做了什么。）');
    return { exitCode: summary.exitCode, summary, text: lines.join('\n') };
  }

  // ── 6. 快照（真跑前唯一一次写盘，且只写快照目录）────────────────
  const snapshotRoot = options.snapshotDir
    ? path.resolve(options.snapshotDir)
    : path.join(home, 'butler-install', 'snapshots', stamp());
  const preRunDir = path.join(snapshotRoot, 'pre-run');
  const snapshotDirs = { preRun: preRunDir }; // 每一步之前都要有一份：回滚那一步时用它
  try {
    takeSnapshot({ profileDir: profile.dir, dir: preRunDir });
  } catch (err) {
    say(`✖ 快照写不出来，按规矩停手（不带着"回滚不了"的批次往下跑）：${err.message}`);
    summary.exitCode = EXIT.UNCLEAN;
    return { exitCode: EXIT.UNCLEAN, summary, text: lines.join('\n') };
  }
  say(`快照：${snapshotRoot}（开跑前一份 pre-run，之后每装成功一步再拍一份）`);
  say(`  ${SNAPSHOT_WARNING}`);
  say('');

  // ── 7. 逐步执行 ────────────────────────────────────────────
  const runStart = Date.now();
  const installedThisRun = [];
  let failure = null;

  for (let i = 0; i < plan.length; i += 1) {
    const entry = plan[i];
    entry.stepIndex = i;
    if (entry.action === 'skip') {
      say(`[${i + 1}/${plan.length}] ⏭ ${entry.item.name} 已满足（${entry.version}），跳过`);
      continue;
    }
    if (Date.now() - runStart > options.budgetMs) {
      failure = { reason: 'budget', entry, message: `整批已跑 ${Math.round((Date.now() - runStart) / 1000)}s，超过墙钟上限 ${Math.round(options.budgetMs / 1000)}s` };
      break;
    }
    const step = installStepFor(entry.item, { profile: options.profile, npmPrefix: npm.prefix });
    say(`\n[${i + 1}/${plan.length}] ${entry.item.group} · ${entry.item.name}`);
    say(`  $ ${formatCommandLine(step.file, step.args)}`);
    const res = await spawnCommand(step.file, step.args, {
      timeoutMs: options.timeoutMs,
      env: execEnv(ctx, step.env),
      onLine: (l) => say(`    ${l}`),
    });
    entry.command = formatCommandLine(step.file, step.args);
    entry.rc = res.code;
    if (res.timedOut || res.code !== 0) {
      failure = {
        reason: 'cmd',
        entry,
        message: `安装命令${res.timedOut ? '超时' : `退出码 ${res.code}`}：${firstLine(res.stderr) || '（无输出）'}`,
        attempted: true,
      };
      say(`  ❌ ${failure.message}`);
      break;
    }
    invalidateDump();
    const verdict = await verifyItem(entry.item, ctx);
    entry.checks = verdict.checks;
    printChecks(say, verdict.checks);
    if (!verdict.ok) {
      failure = { reason: 'criteria', entry, message: '命令成功了，但判据没过（这类"装完不生效"正是本工具要抓的）', attempted: true };
      break;
    }
    // 记下装完之后的真实版本（汇总里要显示"实际装成了什么"，不是"装之前是什么"）
    entry.version = entry.item.type === 'plugin'
      ? profileInstalledVersion(home, options.profile, entry.item.name)
      : globalInstalledVersion(npm.prefix, entry.item.name);
    installedThisRun.push(entry);
    // 每成功一步拍一份：步级回滚要回到"失败那一步之前"，而不是回到整批开跑之前
    const afterDir = path.join(snapshotRoot, `after-${String(i + 1).padStart(2, '0')}`);
    try {
      takeSnapshot({ profileDir: profile.dir, dir: afterDir });
      snapshotDirs[i + 1] = afterDir;
    } catch (err) {
      warn(`这一步之后拍快照失败（${err.message}）：本步已装好，但步级回滚会退到更早的边界`);
    }
  }

  // ── 8. 收尾整批核对 ────────────────────────────────────────
  let sweep = null;
  if (!failure) {
    say('\n== 整批核对 ==');
    sweep = [];
    let sweepFailed = null;
    for (const entry of plan) {
      const verdict = await verifyItem(entry.item, ctx);
      const bad = verdict.checks.find((c) => c.status === 'fail');
      sweep.push({ name: entry.item.name, ok: !bad, checks: verdict.checks });
      if (bad) {
        say(`  ❌ ${entry.item.name}：${bad.label} —— ${bad.detail}`);
        if (!sweepFailed) sweepFailed = entry;
      }
    }
    if (sweepFailed) {
      failure = {
        reason: 'sweep',
        entry: sweepFailed,
        message: '收尾整批核对出现失败项（此时已分不清是哪一步的问题 ⇒ 按整批回滚处理）',
        attempted: true,
      };
    } else {
      say(`  ✅ ${plan.length} 项全部通过`);
    }
  }

  summary.sweep = sweep;
  summary.installedThisRun = installedThisRun.map((e) => e.item.name);

  if (!failure) {
    summary.exitCode = EXIT.OK;
    printSummary(say, plan, null);
    return { exitCode: EXIT.OK, summary, text: lines.join('\n') };
  }

  // ── 9. 回滚 ───────────────────────────────────────────────
  say('');
  say(`✖ 失败：${failure.message}`);
  const mode = failure.reason === 'sweep' ? 'batch' : options.rollbackMode;
  say(`== 回滚（模式 ${mode}${mode === 'batch' ? '：退到本轮开跑之前' : '：只退失败那一步，已成功的前几步保留'}）==`);
  // 步级回滚的落点 = "失败那一步之前"那一次快照（完成第 i-1 步之后拍的）
  const stepIndex = failure.entry && typeof failure.entry.stepIndex === 'number' ? failure.entry.stepIndex : 0;
  const rollbackDir = mode === 'batch'
    ? snapshotDirs.preRun
    : (snapshotDirs[stepIndex] || snapshotDirs.preRun);
  if (mode !== 'batch' && !snapshotDirs[stepIndex] && stepIndex > 0 && installedThisRun.length > 0) {
    warn('失败那一步之前的快照没拍成，退到本轮开跑之前（已成功的前几步会被一起回滚）');
  }
  const targets = [];
  if (mode === 'batch') {
    for (const e of installedThisRun) targets.push(e);
  }
  if (failure.attempted) targets.push(failure.entry);
  // 卸载顺序与安装顺序相反
  const undo = targets.slice().reverse();
  const actions = [];
  for (const entry of undo) {
    // 失败的那一步可能根本没装进任何东西（例如包在注册表上就不存在）：
    // 这时去 remove 会得到一句 "Cannot remove …: project has no dependencies" 的假红，
    // 别把它报成"卸不掉、留残留"。先看它到底在不在。
    if (!isPresentAnywhere(entry.item, ctx)) {
      say(`  ⏭ ${entry.item.name}：这一步没装进任何东西，跳过卸载`);
      actions.push({ name: entry.item.name, command: '(skipped)', rc: 0, timedOut: false, skipped: true });
      continue;
    }
    const step = uninstallStepFor(entry.item, { profile: options.profile, npmPrefix: npm.prefix });
    say(`  $ ${formatCommandLine(step.file, step.args)}`);
    const res = await spawnCommand(step.file, step.args, {
      timeoutMs: options.timeoutMs,
      env: execEnv(ctx, step.env),
      onLine: (l) => say(`    ${l}`),
    });
    actions.push({ name: entry.item.name, command: formatCommandLine(step.file, step.args), rc: res.code, timedOut: res.timedOut });
    if (res.timedOut || res.code !== 0) say(`    ❌ 卸不掉（${res.timedOut ? '超时' : `rc=${res.code}`}）—— 这一项留下了残留`);
  }
  if (!undo.length) say('  （没有跑过任何安装命令，无需卸载）');

  let restored = [];
  let verify = { ok: false, mismatches: [] };
  try {
    restored = restoreSnapshot({ dir: rollbackDir, profileDir: profile.dir });
    for (const a of restored) say(`  快照回放：${a.name} → ${a.action}`);
    verify = verifySnapshotRestored({ dir: rollbackDir, profileDir: profile.dir });
  } catch (err) {
    // 回滚过程本身出错（快照坏了 / 文件被占用）：绝不能装作回滚成功，也不能直接崩
    say(`  ❌ 回滚过程出错：${err.message}`);
    say(`     要人看的快照在：${rollbackDir}`);
  }

  // 回滚"干净"的判据：声明层 sha 回到快照值 + 目标包在声明层不再出现 + 卸载命令没超时。
  // node_modules 里的实体残留**不算不干净**（宿主本来就不清，见 SNAPSHOT_WARNING），但必须报出来。
  const profileAfter = readProfile(home, options.profile);
  const stillDeclared = [];
  const residue = [];
  for (const entry of undo) {
    const name = entry.item.name;
    const declared = entry.item.type === 'plugin'
      ? (Object.prototype.hasOwnProperty.call(profileAfter.deps, name) || profileAfter.bundles.includes(name))
      : Boolean(globalInstalledVersion(npm.prefix, name));
    if (declared) stillDeclared.push(name);
    if (entry.item.type === 'plugin' && profileInstalledVersion(home, options.profile, name)) residue.push(name);
  }
  const removeTimedOut = actions.some((a) => a.timedOut);
  const clean = verify.ok && stillDeclared.length === 0 && !removeTimedOut;
  if (clean) {
    say('  ✅ 回滚核对：声明层文件的 sha256 已回到快照值，本轮回滚掉的包在声明层也不在了');
  } else {
    say('  ❌ 回滚核对：不干净');
    for (const m of verify.mismatches) say(`     - ${m.name}：${m.problem}（期望 ${m.expected || '不存在'} / 实际 ${m.actual || '不存在'}）`);
    for (const name of stillDeclared) say(`     - ${name} 仍留在声明层（依赖列表或组合列表里还在）`);
    for (const a of actions) if (a.timedOut) say(`     - ${a.name} 卸载超时`);
    say(`     要人看的三份快照在：${rollbackDir}`);
  }
  for (const name of residue) say(`     ⚠ ${name} 在 node_modules 里还留着实体文件 —— 宿主清不干净，属已知残留，不影响声明层；重装一次即可覆盖`);
  say(`  ⚠ ${SNAPSHOT_WARNING}`);

  summary.rollback = { mode, clean, snapshotDirUsed: rollbackDir, actions, verify, stillDeclared, residue };
  summary.exitCode = clean ? EXIT.ROLLED_BACK : EXIT.UNCLEAN;
  printSummary(say, plan, failure);
  return { exitCode: summary.exitCode, summary, text: lines.join('\n') };
}

function printSummary(say, plan, failure) {
  say('');
  say('== 汇总 ==');
  for (const entry of plan) {
    let state;
    if (failure && failure.entry === entry) state = '失败';
    else if (entry.action === 'skip') state = '已满足';
    else if (entry.checks) state = '已装';
    else state = '未执行';
    const checks = entry.checks || [];
    const marks = checks.map((c) => (c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⏭')).join('');
    say(`  ${state.padEnd(4, '　')} ${entry.item.name}${entry.version ? ` @ ${entry.version}` : ''} ${marks}`);
  }
}
