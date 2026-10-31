/**
 * 页面背后的**执行器** —— 只编排，不重写安装逻辑。
 *
 * 纪律（改这个文件之前先读）：
 *  1. 装什么 / 怎么装 / 怎么判，全部还是 `lib/plan.mjs` + `lib/run.mjs` 说了算。本文件**只**做：
 *     加锁（同一时刻一批）、跑那一批、把 `run.mjs` 吐出来的进度事件收成内存对象、
 *     把【取消】翻成 AbortSignal、把两个撤回动作转给 `lib/ui-rollback.mjs`。
 *  2. **状态只在内存**（方案 §11.6 · B4）：进程死了这一批就断了，重开页面按 `buildSuiteState()` +
 *     `verifyItem()` **现跑**给真实状态 —— 这比读一份可能过时的状态文件更准。
 *     ⇒ 所以"interrupted"不落盘，也绝不往数据根写字（除了 runSuite 自己该拍的快照）。
 *  3. 进度事件**只收摘要行**，最多留最近 `MAX_LINES` 行、每行截到 `LINE_MAX` 字：
 *     16 项里有 6 项是 `npm i -g`，原始输出是 MB 级的，塞进内存和页面就是灾难。
 *  4. 🔴 不许 monkey-patch `process.stdout.write` 抓进度（会污染整个向导页进程的输出：
 *     .cmd 窗口的日志与多请求之间互相穿插）。进度只从 `runSuite(options, hooks)` 的回调来。
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSuiteState } from './plan.mjs';
import { runSuite } from './run.mjs';
import { EXIT } from './cli-args.mjs';
import { formatCommandLine } from './exec.mjs';
import { declarationFingerprint, checkPrecondition, uninstallBatch, restoreDeclarations } from './ui-rollback.mjs';
import { runLabel } from './item-status.mjs';

/** 进度里最多留多少行摘要（够看"卡在哪一项"，又不至于把内存堆满） */
export const MAX_LINES = 60;
/** 每行摘要最多留多少字 */
export const LINE_MAX = 400;
/** `--ui` 路径的墙钟上限天花板：30 分钟（16 项里有 6 个 npm -g，冷缓存首装很慢） */
export const UI_BUDGET_CAP_MS = 30 * 60 * 1000;
/** `--budget` 的 CLI 缺省值（`lib/cli-args.mjs` 里那个 300s）：等于它 ⇒ 认为"用户没显式给" */
export const CLI_DEFAULT_BUDGET_MS = 300000;

function stamp() {
  // 与 run.mjs 的 stamp() 同形，但多带毫秒与 pid：页面里快速连点两次不会撞同一个快照目录
  const iso = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-');
  return `${iso.replace(/\..*$/, '')}-${String(new Date().getMilliseconds()).padStart(3, '0')}-${process.pid}`;
}

/** 这一批的墙钟上限：只有"没被显式改过"的 --budget 才抬，显式的尊重用户 */
export function effectiveBudgetMs({ options = {}, installCount = 1 } = {}) {
  const perStep = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000;
  const bySteps = Math.min(UI_BUDGET_CAP_MS, perStep * Math.max(1, installCount));
  const asked = Number.isFinite(options.budgetMs) ? options.budgetMs : CLI_DEFAULT_BUDGET_MS;
  if (asked !== CLI_DEFAULT_BUDGET_MS) return asked;
  return Math.max(asked, bySteps);
}

/**
 * 预计时长：按"最慢的那类"给区间（插件走宿主 → 约 25s；npm -g 冷缓存 → 约 45s）。
 * 这是给人看的一句话，不是承诺；页面同时会显示真实预算。
 */
export function estimateDurationMs(items = []) {
  let min = 0;
  let max = 0;
  for (const item of items) {
    const cli = item.type === 'cli';
    min += cli ? 25 * 1000 : 15 * 1000;
    max += cli ? 60 * 1000 : 35 * 1000;
  }
  return { minMs: min, maxMs: max, text: `${Math.max(1, Math.round(min / 60000))}–${Math.max(1, Math.round(max / 60000))} 分钟` };
}

/** 给页面的"等价命令行"（方案 §11.6 · S3：必须带 --apply，不然用户拿到的是演练命令） */
export function equivalentCommand({ options = {}, profile, budgetMs }) {
  const args = ['--profile', profile];
  if (options.manifest) args.push('--manifest', options.manifest);
  if (options.home) args.push('--home', options.home);
  if (options.npmPrefix) args.push('--npm-prefix', options.npmPrefix);
  if (options.upgrade) args.push('--upgrade');
  if (Array.isArray(options.only) && options.only.length) args.push('--only', options.only.join(','));
  if (Array.isArray(options.skip) && options.skip.length) args.push('--skip', options.skip.join(','));
  args.push('--apply');
  if (Number.isFinite(budgetMs)) args.push('--budget', String(Math.max(1, Math.round(budgetMs / 1000))));
  return formatCommandLine('dsh-butler-install', args);
}

function statusMessage(status, { exitCode, aborted, rollback }) {
  if (status === 'cancelled') {
    return [
      '已取消 —— 装了一半，这不是"干净撤回"：已经装好的项留着；正在跑的那一项被按失败处理（默认 step 回滚：退到这一步之前）。',
      rollback && rollback.clean === false ? '注意：那一步的回滚也不干净，报告里会列出没卸掉的项。' : '',
      '要让"已装"真的变回"未装"，用【卸载这次装的】。',
    ].filter(Boolean).join('');
  }
  if (status === 'done') return '这一批全绿：每一项都过了当场判据（命令退出码 0 不算成功，判据过了才算）。';
  if (status === 'failed') {
    return `这一批有失败项（退出码 ${exitCode}）：${exitCode === EXIT.ROLLED_BACK ? '已按回滚策略回滚，报告里写着回滚干净了没有' : exitCode === EXIT.UNCLEAN ? '回滚不干净，要人看报告里哪份文件对不上' : '前置条件/清单有问题，什么都没改'}。`;
  }
  if (status === 'error') return '安装器自己抛错了（不是判据失败）：这一批的结果不可信，请按控制台日志排查。';
  if (status === 'cancelling') return '正在停：在杀当前那条命令的进程树。';
  return aborted ? '已取消。' : '';
}

/**
 * 建一个执行器（一个服务进程一个）。
 * @param {{options: object, onLog?: (line: string) => void}} args options = CLI 选项同形
 */
export function createInstallRunner({ options = {}, onLog = null } = {}) {
  const state = {
    status: 'idle',
    batchId: null,
    startedAt: null,
    finishedAt: null,
    index: 0,
    total: 0,
    current: null,
    items: [],
    lines: [],
    lastLineAt: null,
    lastEventAt: null,
    exitCode: null,
    message: '',
    result: null,
    context: null,
    settlement: null,
    rollback: null,
    busy: false,
  };
  let controller = null;
  let activePromise = null;

  const log = (line) => {
    if (typeof onLog === 'function') {
      try { onLog(line); } catch { /* 日志出口坏了不影响安装 */ }
    }
  };

  const pushLine = (line) => {
    const text = String(line == null ? '' : line).slice(0, LINE_MAX);
    if (!text) return;
    state.lines.push(text);
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
    state.lastLineAt = new Date().toISOString();
  };

  function progressOf() {
    const counts = { pending: 0, running: 0, ok: 0, skip: 0, fail: 0, cancelled: 0 };
    for (const item of state.items) counts[item.status] = (counts[item.status] || 0) + 1;
    const sinceLastLineMs = state.lastLineAt ? Date.now() - Date.parse(state.lastLineAt) : null;
    return {
      ok: true,
      status: state.status,
      batchId: state.batchId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      index: state.index,
      total: state.total,
      current: state.current,
      // label 由 lib/item-status.mjs 算好一起下发：页面只读不算（同源，§11.6 · S1）
      items: state.items.map((i) => ({ ...i, label: runLabel(i.status) })),
      lines: state.lines.slice(),
      counts,
      lastLineAt: state.lastLineAt,
      lastEventAt: state.lastEventAt,
      sinceLastLineMs,
      // 静默期本来就可能 >60s（npm 静默下载）：这不是"卡死"，只是"没有新行"。两个读数都给出来
      quietFor60s: sinceLastLineMs !== null && sinceLastLineMs > 60000,
      exitCode: state.exitCode,
      message: state.message,
      result: state.result,
      // 撤回的可用性：B 要靠"本轮收尾时的 sha"，进程重启过就没有了 —— 如实说，不假装能撤
      settlement: state.settlement ? { at: state.settlement.at } : null,
      rollback: state.rollback,
      can: {
        start: !state.busy,
        cancel: state.status === 'running',
        rollback: !state.busy && Boolean(state.result),
      },
    };
  }

  async function buildPreview() {
    const built = await buildSuiteState({ ...options, apply: false, uninstall: false, json: false });
    if (!built.ok) {
      return {
        ok: false,
        exitCode: built.exitCode,
        profile: options.profile,
        errors: built.log.filter((l) => l && l.trim()),
      };
    }
    const st = built.state;
    const items = st.items.map((i) => ({
      step: i.step,
      name: i.name,
      group: i.group,
      type: i.type,
      action: i.action,
      command: i.command,
      criteria: i.criteria,
      installedVersion: i.installedVersion,
      inRange: i.inRange,
    }));
    const willInstall = items.filter((i) => i.action === 'install');
    const budgetMs = effectiveBudgetMs({ options, installCount: willInstall.length });
    const estimate = estimateDurationMs(willInstall);
    return {
      ok: true,
      profile: st.profile,
      home: st.home,
      npmPrefix: st.npmPrefix,
      npmPrefixSource: st.npmPrefixSource,
      profileExists: st.profileExists,
      counts: st.counts,
      preflight: st.preflight,
      items,
      willInstall: willInstall.map((i) => i.name),
      skipped: items.filter((i) => i.action === 'skip').map((i) => i.name),
      budgetMs,
      estimate,
      snapshotHint: path.join(st.home, 'butler-install', 'snapshots', '<开跑那一刻的时间戳>-ui/'),
      equivalentCommand: equivalentCommand({ options, profile: st.profile, budgetMs }),
      // 两步确认的第一半：这里只回答"将做什么"，一条命令都不跑
      note: '这一步只算给你看：不跑任何命令、不写任何文件。真的要装，页面还要再点一次【确认，开始】（带 confirm:true）。',
    };
  }

  function handleEvent(event) {
    const at = new Date().toISOString();
    state.lastEventAt = at;
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'log') {
      pushLine(event.detail);
      return;
    }
    if (event.kind === 'step-start') {
      state.index = event.index;
      state.total = event.total;
      state.current = { index: event.index, name: event.item, action: event.action, startedAt: at };
      const item = state.items.find((i) => i.index === event.index);
      if (item && item.status === 'pending') item.status = 'running';
      return;
    }
    if (event.kind === 'step-done') {
      const item = state.items.find((i) => i.index === event.index);
      if (item) {
        if (event.ok) item.status = /已满足/.test(String(event.detail || '')) ? 'skip' : 'ok';
        else item.status = /取消/.test(String(event.detail || '')) ? 'cancelled' : 'fail';
        item.detail = String(event.detail || '').slice(0, LINE_MAX);
      }
      if (state.current && state.current.index === event.index) state.current = null;
      return;
    }
    if (event.kind === 'batch-done') {
      pushLine(`== 这一批结束：${event.detail || `退出码 ${event.exitCode}`} ==`);
    }
  }

  async function runBatch(preview) {
    const profileDir = path.join(preview.home, 'profiles', preview.profile);
    const snapshotRoot = path.join(preview.home, 'butler-install', 'snapshots', `${stamp()}-ui`);
    controller = new AbortController();
    state.status = 'running';
    state.batchId = `ui-${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    state.index = 0;
    state.total = preview.items.length;
    state.current = null;
    state.items = preview.items.map((i) => ({
      index: i.step,
      name: i.name,
      action: i.action,
      status: i.action === 'skip' ? 'skip' : 'pending',
      detail: i.action === 'skip' ? '已满足，跳过' : '',
    }));
    state.lines = [];
    state.lastLineAt = null;
    state.exitCode = null;
    state.message = '';
    state.result = null;
    state.rollback = null;
    state.settlement = null;
    state.context = {
      home: preview.home,
      profile: preview.profile,
      profileDir,
      snapshotRoot,
      budgetMs: preview.budgetMs,
      equivalentCommand: preview.equivalentCommand,
    };

    const runOptions = {
      ...options,
      // 页面内部走的永远是"真装"分支；`--ui` 与 `--apply` 的互斥只在 CLI 参数层
      apply: true,
      uninstall: false,
      json: false,
      budgetMs: preview.budgetMs,
      // 快照目录由我们点名：撤回时要靠它找 pre-run，不能让 runSuite 自己生成一个我们看不见的路径
      snapshotDir: snapshotRoot,
    };

    log(`[ui] 开始安装：${preview.profile} · ${preview.willInstall.length} 项 · 预算 ${Math.round(preview.budgetMs / 1000)}s · 快照 ${snapshotRoot}`);
    try {
      const res = await runSuite(runOptions, { signal: controller.signal, onEvent: handleEvent });
      state.exitCode = res.exitCode;
      state.result = {
        exitCode: res.exitCode,
        installed: (res.summary && Array.isArray(res.summary.installedThisRun)) ? res.summary.installedThisRun.slice() : [],
        snapshotRoot,
        rollback: (res.summary && res.summary.rollback) ? res.summary.rollback : null,
        sweep: (res.summary && res.summary.sweep) ? res.summary.sweep : null,
        equivalentCommand: preview.equivalentCommand,
      };
      // 记下"本轮收尾时的 sha"：撤回动作 B 的前置核对就靠它
      state.settlement = { at: new Date().toISOString(), files: declarationFingerprint(profileDir) };
      const aborted = Boolean(controller && controller.signal.aborted);
      state.status = aborted ? 'cancelled' : (res.exitCode === EXIT.OK ? 'done' : 'failed');
      state.message = statusMessage(state.status, { exitCode: res.exitCode, aborted, rollback: state.result.rollback });
    } catch (err) {
      const aborted = Boolean(controller && controller.signal.aborted);
      state.status = aborted ? 'cancelled' : 'error';
      state.message = aborted
        ? '已取消（收尾时安装器自己抛了个错，这一批的状态以快照与页面判据为准）'
        : `安装器自己抛错了：${String(err && err.message ? err.message : err)}（不是判据失败；结果不可信）`;
      state.settlement = { at: new Date().toISOString(), files: declarationFingerprint(profileDir) };
      log(`[ui] 异常：${state.message}`);
    } finally {
      state.finishedAt = new Date().toISOString();
      state.current = null;
      state.busy = false;
      controller = null;
      activePromise = null;
      log(`[ui] 这一批结束：status=${state.status} exitCode=${state.exitCode}`);
    }
  }

  return {
    /** 只算不做（两步确认的第一半） */
    async preview() {
      const preview = await buildPreview();
      if (!preview.ok) return { status: preview.exitCode === EXIT.USAGE ? 400 : 500, body: preview };
      return { status: 200, body: preview };
    },

    /** 真的开跑（两步确认的第二半：必须 confirm:true） */
    async start(body = {}) {
      if (state.busy) {
        return {
          status: 409,
          body: {
            ok: false,
            error: 'busy',
            message: '已经有一批在跑：同一时刻只允许一批（单飞锁在进程内存里，不落盘）',
            progress: progressOf(),
          },
        };
      }
      if (body && body.confirm !== true) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'confirm-required',
            message: '这是两步确认的第二步：请求体必须带 confirm:true。先调一次 /install/preview 让用户看清"将对哪个 profile 做哪几件事"。',
          },
        };
      }
      // 🔴 先占锁再 await：buildPreview 里有 await，不先占锁的话两个并发 start 会双双通过检查
      state.busy = true;
      let preview;
      try {
        preview = await buildPreview();
      } catch (err) {
        state.busy = false;
        return { status: 500, body: { ok: false, error: 'internal-error', message: String(err && err.message ? err.message : err) } };
      }
      if (!preview.ok) {
        state.busy = false;
        return { status: 400, body: preview };
      }
      if (preview.preflight && preview.preflight.length) {
        state.busy = false;
        return { status: 400, body: { ok: false, error: 'preflight', message: preview.preflight.join(' / '), preflight: preview.preflight } };
      }
      if (!preview.willInstall.length) {
        state.busy = false;
        return { status: 400, body: { ok: false, error: 'nothing-to-do', message: '这一批没有要装的项（全部已满足）；要强制重跑，用命令行的 --upgrade' } };
      }
      // 起跑：不 await（HTTP 立刻回 202，进度靠 /install/progress 轮询）
      activePromise = runBatch(preview);
      return {
        status: 202,
        body: { ok: true, status: 'running', batchId: state.batchId, progress: progressOf(), equivalentCommand: preview.equivalentCommand },
      };
    },

    /** 取消：只对"正在跑"的批次有效；重复取消返回"已经在停" */
    cancel() {
      if (state.status === 'cancelling') {
        return { status: 202, body: { ok: true, status: 'cancelling', alreadyStopping: true, progress: progressOf() } };
      }
      if (state.status !== 'running' || !controller) {
        return {
          status: 409,
          body: { ok: false, error: 'not-running', message: '现在没有在跑的批次（单飞锁是空的），没什么可取消的', progress: progressOf() },
        };
      }
      state.status = 'cancelling';
      state.lastEventAt = new Date().toISOString();
      pushLine('⏹ 收到取消：正在杀当前那条命令的进程树（AbortSignal → killTree）。已经装好的项会留着，不会自动整批回滚。');
      controller.abort();
      return {
        status: 202,
        body: {
          ok: true,
          status: 'cancelling',
          message: '正在停：当前那条命令的进程树会被杀掉（目标 ≤3 秒）。⚠️ 这不是"干净撤回"——已装好的项会留着，当前项可能只装了一半。',
          progress: progressOf(),
        },
      };
    },

    /** 进度：纯内存读，幂等，不写日志、不 spawn（页面按 500–1000ms 轮询它） */
    progress() {
      return { status: 200, body: progressOf() };
    },

    /**
     * 撤回的两个动作（方案 §11.6 · B5）：
     *  action='uninstall'              → 【卸载这次装的】（默认推荐）
     *  action='restore-declarations'   → 【恢复声明层到装前】（必须先过前置核对）
     */
    async rollback(body = {}) {
      const action = String((body && body.action) || '');
      if (state.busy) {
        return { status: 409, body: { ok: false, error: 'busy', message: '有一批正在跑（或在撤），不能同时改同一个 profile', progress: progressOf() } };
      }
      if (action === 'uninstall') {
        const names = state.result && Array.isArray(state.result.installed) ? state.result.installed : [];
        if (!names.length) {
          return {
            status: 400,
            body: {
              ok: false,
              error: 'nothing-installed',
              message: '这一轮没有装成任何项（或者本轮还没跑过），没有"这次装的"可卸',
            },
          };
        }
        state.busy = true;
        const previousStatus = state.status;
        state.status = 'rolling-back';
        const before = state.items.map((i) => ({ ...i }));
        state.items = names.map((name, idx) => ({ index: idx + 1, name, action: 'uninstall', status: 'pending', detail: '' }));
        state.total = names.length;
        state.index = 0;
        try {
          const result = await uninstallBatch({
            options: { ...options, snapshotDir: null },
            names,
            hooks: {
              onEvent: (ev) => {
                if (ev.kind === 'step-start') { state.index = ev.index; state.current = { index: ev.index, name: ev.item, action: 'uninstall' }; }
                else if (ev.kind === 'step-done') {
                  const item = state.items.find((i) => i.index === ev.index);
                  if (item) { item.status = ev.ok ? 'ok' : 'fail'; item.detail = String(ev.detail || '').slice(0, LINE_MAX); }
                } else if (ev.kind === 'log') pushLine(ev.detail);
              },
            },
          });
          state.rollback = { action: 'uninstall', at: new Date().toISOString(), ok: result.ok, exitCode: result.exitCode, names };
          // 卸载动过声明层 ⇒ "本轮收尾时的 sha"不再成立，B 的基准作废（如实处置，不假装还能撤）
          state.settlement = null;
          return {
            status: 200,
            body: {
              ok: result.ok,
              action: 'uninstall',
              exitCode: result.exitCode,
              names,
              text: result.text,
              honest: result.honest,
              progress: progressOf(),
            },
          };
        } finally {
          state.busy = false;
          state.current = null;
          state.status = previousStatus;
          state.items = before;
        }
      }

      if (action === 'restore-declarations') {
        if (!state.result || !state.result.snapshotRoot) {
          return { status: 400, body: { ok: false, error: 'no-snapshot', message: '这一轮还没跑过安装（或者服务重启过），没有可用的快照' } };
        }
        const profileDir = state.context ? state.context.profileDir : null;
        const pre = checkPrecondition({ settlement: state.settlement, profileDir });
        if (!pre.ok) {
          return {
            status: 412,
            body: {
              ok: false,
              error: 'precondition-failed',
              reason: pre.reason,
              changed: pre.changed,
              message: pre.message,
              hint: '要真的让"已装"变回"未装"，用【卸载这次装的】（它不覆盖文件，看的是现在装着什么）。',
            },
          };
        }
        const result = restoreDeclarations({ snapshotRoot: state.result.snapshotRoot, profileDir });
        state.rollback = { action: 'restore-declarations', at: new Date().toISOString(), ok: result.ok, snapshotDir: result.snapshotDir };
        // 声明层已经被写回装前 ⇒ 原来的"收尾 sha"作废
        state.settlement = null;
        return {
          status: 200,
          body: {
            ok: result.ok,
            action: 'restore-declarations',
            snapshotDir: result.snapshotDir,
            actions: result.actions,
            verify: result.verify,
            error: result.error,
            warning: result.warning,
            honest: result.honest,
            progress: progressOf(),
          },
        };
      }

      return {
        status: 400,
        body: {
          ok: false,
          error: 'unknown-action',
          message: 'action 只能是 uninstall（卸载这次装的）或 restore-declarations（恢复声明层到装前）',
        },
      };
    },

    /** 夹具/退出钩子用：拿到"正在跑的批次"的控制权（没有就 null） */
    _debug() {
      return { busy: state.busy, status: state.status, controller, activePromise };
    },
  };
}
