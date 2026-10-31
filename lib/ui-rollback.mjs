/**
 * 撤回的两条路 —— 这里只做「诚实」的那两个动作（方案 §11.6 · B5 定的重写口径）。
 *
 * 🔴 三不许（改这个文件之前先读，每一条都是"看起来能跑、实际会毁东西"）：
 *  1. **不许把 `--rollback` 当动作**：它只是 `lib/run.mjs` 里的**失败策略枚举**（`step|batch`），
 *     只在"某一批失败之后"那段代码里被读；外面根本没有"拿某个快照回滚"的函数。
 *  2. **不许无条件 restoreSnapshot**：它会 `copyFileSync` 覆盖四份声明层文件。用户在"装完 → 点撤回"
 *     之间完全可能用 DSH 侧边栏又装了个插件（宿主也在写同一份 package.json）——
 *     盲目覆盖等于把人家刚装的东西**静默抹掉**。所以动作 B 必须先过前置核对。
 *  3. **不许声称"已撤回到安装前"**：动作 B 只还原声明层四份文件；`node_modules` 里的实体
 *     与 `npm -g` 的 CLI 包**不会消失**，重开页面照样显示"已装"。文案必须与真实效果一致。
 *
 * 于是两个动作：
 *  - **动作 A【卸载这次装的】**（默认推荐）= 逐项走 `--uninstall` 语义：幂等、**不覆盖任何文件**，
 *    它看的是"现在装着什么"，所以才能真的让"已装"变回"未装"。
 *  - **动作 B【恢复声明层到装前】** = `restoreSnapshot` + 前置核对（当前四份文件的 sha 必须等于
 *    本轮收尾时的 sha；不等 ⇒ 拒动并说清"这期间有别的程序改过这些文件"）。
 */
import path from 'node:path';
import { SNAPSHOT_FILES, SNAPSHOT_WARNING, restoreSnapshot, verifySnapshotRestored, sha256 } from './snapshot.mjs';
import { runSuite, EXIT } from './run.mjs';

/** 四份声明层文件的 sha 指纹（文件不存在记 null —— "不存在"本身也是状态） */
export function declarationFingerprint(profileDir) {
  const files = {};
  for (const name of SNAPSHOT_FILES) {
    try {
      files[name] = sha256(path.join(profileDir, name));
    } catch {
      files[name] = null;
    }
  }
  return files;
}

/**
 * 动作 B 的前置核对：当前 sha 必须逐份等于「本轮收尾时的 sha」。
 *
 * 为什么不是"快照里的 sha"：快照是**开跑前**的；而这四份文件在整批跑的过程中本来就一直在变
 * （每装一项就变一次）。真正该比的是"这一轮结束那一刻的样子"——它等于当前的样子才说明
 * 这期间没别人动过手。用快照 sha 去比当前 sha，整批装完之后必然"不等"，等于永远拒动。
 *
 * @param {{settlement: {at:string, files: Record<string,string|null>}|null, profileDir: string}} args
 */
export function checkPrecondition({ settlement, profileDir }) {
  if (!settlement || !settlement.files) {
    return {
      ok: false,
      reason: 'no-settlement',
      changed: [],
      message: '没有"本轮收尾时的 sha"可核（服务重启过，或者这一轮还没跑完）：不能盲目拿旧快照覆盖现在的声明层',
    };
  }
  const now = declarationFingerprint(profileDir);
  const changed = [];
  for (const name of SNAPSHOT_FILES) {
    const expected = settlement.files[name] ?? null;
    const actual = now[name] ?? null;
    if (expected !== actual) changed.push({ name, expected, actual });
  }
  if (changed.length) {
    return {
      ok: false,
      reason: 'changed',
      changed,
      message: `这期间有别的程序改过这些文件（${changed.map((c) => c.name).join(' / ')}）—— 现在覆盖会把人家刚写的东西一起抹掉，所以拒动`,
    };
  }
  return { ok: true, reason: 'clean', changed: [], verifiedAt: new Date().toISOString() };
}

/**
 * 动作 A：把「这一次装成的项」逐项卸掉（`--uninstall` 语义）。
 *
 * 注意它**不是**"回滚"：卸载看的是"现在装着什么"。所以：
 *  - 用户在装完之后自己又装回来的，也会被一起卸掉（这正是"卸载这次装的"该有的行为，但要写清）；
 *  - 它不写、不覆盖任何声明层文件内容，只让宿主自己摘条目。
 *
 * @param {{options: object, names: string[], hooks?: object}} args
 */
export async function uninstallBatch({ options, names, hooks = {} }) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (!list.length) {
    return {
      ok: false,
      reason: 'nothing-installed',
      exitCode: null,
      message: '这一轮没有装成任何项，没有可卸载的',
    };
  }
  const runOptions = {
    ...options,
    // 卸载看现状 ⇒ 必须真跑（演练档会在最前面就 return）；--uninstall 在 CLI 层与 --ui 互斥，
    // 这里是页面内部的第二个动作，不是命令行开关，所以直接给 runSuite 的选项。
    apply: true,
    uninstall: true,
    only: list.slice(),
    skip: [],
    json: false,
    snapshotDir: null,
  };
  const result = await runSuite(runOptions, hooks);
  return {
    ok: result.exitCode === EXIT.OK,
    exitCode: result.exitCode,
    names: list.slice(),
    text: result.text,
    summary: result.summary,
    honest: [
      '这是「卸载这次装的」：走 --uninstall 语义，看的是现在装着什么，所以它会真的让"已装"变回"未装"。',
      '它不覆盖任何文件：不写 package.json / cordis.patch.yml 的内容，只让宿主自己摘掉条目。',
      'node_modules 里的实体文件与包管理器缓存仍可能留着残留 —— 那是宿主的已知行为，不是"没卸干净"。',
    ],
  };
}

/**
 * 动作 B：把声明层四份文件恢复到**本轮开跑前**的样子。
 * 调用方必须先跑过 `checkPrecondition`；本函数不做拦截（它只负责"按快照写回 + 复核"）。
 *
 * @param {{snapshotRoot: string, profileDir: string}} args snapshotRoot = 本批的快照根（里面含 pre-run/）
 */
export function restoreDeclarations({ snapshotRoot, profileDir }) {
  const dir = path.join(snapshotRoot, 'pre-run');
  let actions = [];
  let verify = { ok: false, mismatches: [] };
  let error = null;
  try {
    actions = restoreSnapshot({ dir, profileDir });
    verify = verifySnapshotRestored({ dir, profileDir });
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  return {
    ok: !error && verify.ok,
    snapshotDir: dir,
    actions,
    verify,
    error,
    warning: SNAPSHOT_WARNING,
    honest: [
      '只还原**声明层**四份文件（package.json / pnpm-lock.yaml / cordis.patch.yml / pnpm-workspace.yaml）。',
      'node_modules 里的包实体与 npm -g 装的命令行工具**不会**因此消失 ⇒ 重开页面大概率仍显示"已装"。',
      '想真的让"已装"变回"未装"，请用另一个动作【卸载这次装的】。',
    ],
  };
}
