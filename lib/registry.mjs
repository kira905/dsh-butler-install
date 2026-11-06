/**
 * 「注册表上这个区间内现在最高是哪一版」—— 装后自检的第二半判据。
 *
 * 为什么非要有它：老判据只查「实体版本落在清单写的区间内」，而照清单装的时候
 * 命令里带的正是区间下界（`<包>@^x.y.z`）；只要下界还在区间里，这条判据就**永远绿**。
 * 实测过的后果（2026-11-06）：整批 17 项 rc=0 全绿，11 个包的实装版本正好等于下界，
 * 其中 10 个落后 npm latest，还有一个装到了已 deprecate 的 0.1.0。
 * ⇒ 判据必须对着**清单外面的世界**核一次，不能自己核自己。
 *
 * 取数只用一条只读命令：`npm view <name>@<range> version --json`。
 * 它返回的是「这个区间内所有匹配的版本」，取其中最大的稳定版就是"当前可用的最新合规版"。
 * 取不到（没网 / 私有源需要登录 / 包已下架）时**绝不冒充通过**：状态记 `unknown`，
 * 由调用方在汇总里明说"这一项没核是否落后"，而不是悄悄给个绿。
 *
 * ⚠️ 它只读、幂等，而且**同一个进程里同一个包只查一次**（缓存）：
 * 每步判据 + 收尾整批核对会重复问同一个包，缓存把 34 次压回 17 次。
 */
import { spawnCommand } from './exec.mjs';
import { parseVersion, compareVersions, satisfies } from './semver.mjs';

export const DEFAULT_REGISTRY_TIMEOUT_MS = 30000;

/**
 * 解析 `npm view <spec> version --json` 的输出。
 * 三种形态都见过：单个字符串、字符串数组、空数组。
 * @returns {{ok:boolean, versions:string[], problem?:string}}
 */
export function parseViewVersions(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { ok: false, versions: [], problem: 'registry 没有返回任何版本' };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // `--json` 之外的老 npm 会一行一个版本；按行兜底
    const lines = text.split(/\r?\n/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const versions = lines.filter((l) => parseVersion(l));
    if (!versions.length) return { ok: false, versions: [], problem: `输出解析不了：${JSON.stringify(text.slice(0, 120))}` };
    return { ok: true, versions };
  }
  if (typeof data === 'string') return { ok: true, versions: [data.trim()] };
  if (Array.isArray(data)) {
    const versions = data.map((v) => String(v).trim()).filter((v) => parseVersion(v));
    return { ok: true, versions };
  }
  return { ok: false, versions: [], problem: `输出不是版本列表：${JSON.stringify(text.slice(0, 120))}` };
}

/**
 * 从一批版本里挑出「落在区间内且版本号最大」的那个（预发布不算候选）。
 * @returns {{ok:boolean, best:string, rejected:number, problem?:string}}
 */
export function pickHighestInRange(rangeText, versions) {
  let best = null;
  let rejected = 0;
  for (const raw of versions) {
    const v = parseVersion(raw);
    if (!v) { rejected += 1; continue; }
    const verdict = satisfies(rangeText, raw);
    if (verdict !== 'yes') { rejected += 1; continue; }
    if (!best || compareVersions(v, parseVersion(best)) > 0) best = raw;
  }
  if (!best) return { ok: false, best: '', rejected, problem: `区间 ${rangeText} 在注册表上没有任何可用版本` };
  return { ok: true, best, rejected };
}

/**
 * 造一个解析器。**构造零成本**（不 spawn、不联网），第一次 lookup 才真查。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true]  false = 整条判据关闭（离线/演示），lookup 一律返回 skipped
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.run]  注入的命令执行器（夹具用，签名同 spawnCommand）
 * @param {string} [opts.npmCommand='npm']
 * @param {Object<string,string>} [opts.snapshot]  {包名: 版本} 离线快照；给了就不再联网
 * @param {string} [opts.source]  显示用的取数来源说明
 */
export function createRegistryResolver(opts = {}) {
  const enabled = opts.enabled !== false;
  const timeoutMs = opts.timeoutMs || DEFAULT_REGISTRY_TIMEOUT_MS;
  const run = opts.run || ((file, args, o) => spawnCommand(file, args, o));
  const npmCommand = opts.npmCommand || 'npm';
  const snapshot = opts.snapshot || null;
  const cache = opts.cache || new Map();
  let queried = 0;

  async function query(name, rangeText) {
    if (snapshot) {
      const got = snapshot[name];
      if (!got) return { ok: false, versions: [], problem: `离线取数里没有 ${name}` };
      return { ok: true, versions: [String(got)], offline: true };
    }
    queried += 1;
    const spec = `${name}@${rangeText}`;
    const res = await run(npmCommand, ['view', spec, 'version', '--json'], { timeoutMs, quiet: true });
    if (res.timedOut) return { ok: false, versions: [], problem: `npm view ${spec} 超时（${Math.round(timeoutMs / 1000)}s）` };
    if (res.code !== 0) {
      const first = String(res.stderr || '').trim().split(/\r?\n/).find((l) => l && !/^npm (warn|notice)/i.test(l)) || '';
      return { ok: false, versions: [], problem: `npm view ${spec} 退出码 ${res.code}${first ? `：${first.slice(0, 160)}` : ''}` };
    }
    const parsed = parseViewVersions(res.stdout);
    if (!parsed.ok) return { ok: false, versions: [], problem: parsed.problem };
    return { ok: true, versions: parsed.versions };
  }

  /**
   * @param {{name:string, versionRange:string}} item
   * @returns {Promise<{status:'ok'|'skipped'|'unknown', best:string, source:string, detail:string}>}
   */
  async function lookup(item) {
    if (!enabled) {
      return { status: 'skipped', best: '', source: 'off', detail: '注册表核对被关闭（--no-registry）：只核"落在区间内"，没核是否落后' };
    }
    const key = `${item.name}@${item.versionRange}`;
    if (cache.has(key)) return cache.get(key);
    const got = await query(item.name, item.versionRange);
    let result;
    if (!got.ok) {
      result = { status: 'unknown', best: '', source: snapshot ? 'snapshot' : 'npm-view', detail: `取不到注册表版本（${got.problem}）⇒ 没核是否落后` };
    } else {
      const picked = pickHighestInRange(item.versionRange, got.versions);
      result = picked.ok
        ? { status: 'ok', best: picked.best, source: snapshot ? 'snapshot' : 'npm-view', detail: `区间 ${item.versionRange} 内注册表现有最高 ${picked.best}` }
        : { status: 'unknown', best: '', source: snapshot ? 'snapshot' : 'npm-view', detail: `${picked.problem} ⇒ 没核是否落后` };
    }
    cache.set(key, result);
    return result;
  }

  return {
    lookup,
    stats: () => ({ queried, cached: cache.size, enabled, source: snapshot ? 'snapshot' : enabled ? 'npm-view' : 'off' }),
    clear: () => cache.clear(),
  };
}

/** 把 resolver 塞进一个可复用的 ctx（已存在就不换，保证一次运行内缓存不丢） */
export function ensureRegistry(ctx, opts) {
  if (ctx.registry) return ctx.registry;
  const resolver = createRegistryResolver(opts);
  ctx.registry = resolver;
  return resolver;
}
