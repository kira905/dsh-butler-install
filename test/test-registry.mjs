/**
 * 「装上来的是不是最新合规版」这条判据的夹具。
 *
 * 这是缺陷 A 的另一半：命令层修好了（`^` 不再被吃掉），但如果自检还只查「落在区间内」，
 * 那"装成了下界"照样绿 —— 两处一致地错，比不一致更难发现。
 *
 * 三条判据都要能红：
 *   ① 区间内但明显落后 ⇒ 判红（不是"通过"）
 *   ② 注册表取不到 ⇒ 记"未核"，不冒充通过也不假红
 *   ③ 关掉核对（--no-registry）⇒ 汇总里必须明说没核过
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseViewVersions, pickHighestInRange, createRegistryResolver } from '../lib/registry.mjs';
import { verifyItem } from '../lib/run.mjs';
import { runSuite, EXIT } from '../lib/run.mjs';
import { makeFakeEnv, pluginItem, cliItem, } from './lib/fake-env.mjs';
import { readJsonSafe, writeJson } from './lib/harness.mjs';

export const name = '装后判据：是不是区间内最新合规版（含判红）';

/** 假 registry：按包名回一段固定版本列表，零网络 */
function fakeRegistry(map, opts = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push(args.join(' '));
    // args = ['view', '<name>@<range>', 'version', '--json']
    const spec = String(args[1] || '');
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    if (opts.fail) return { code: 1, stdout: '', stderr: opts.fail, timedOut: false, cmdline: '' };
    const versions = map[name];
    if (!versions) return { code: 1, stdout: '', stderr: `npm error 404  ${name}`, timedOut: false, cmdline: '' };
    return { code: 0, stdout: JSON.stringify(versions), stderr: '', timedOut: false, cmdline: '' };
  };
  return { run, calls };
}

function baseOptions(env, extra = {}) {
  return {
    profile: 'fixture',
    profileExplicit: true,
    manifest: env.manifestPath,
    apply: true,
    only: [],
    skip: [],
    upgrade: false,
    rollbackMode: 'step',
    uninstall: false,
    npmPrefix: env.npmPrefix,
    home: env.home,
    timeoutMs: 60000,
    budgetMs: 300000,
    json: true,
    // 夹具里不扫真实安装目录、不起 PowerShell：桌面版那条判据与本格无关
    desktopRoots: [path.join(env.dir, 'no-desktop-here')],
    allowProcessProbe: false,
    ...extra,
  };
}

export async function run(c) {
  // ── ① 解析 `npm view … version --json` 的三种形态 ──────────────
  c.eq(parseViewVersions('"0.1.4"').versions, ['0.1.4'], '单版本输出（字符串）');
  c.eq(parseViewVersions('["0.1.0","0.1.4"]').versions, ['0.1.0', '0.1.4'], '多版本输出（数组）');
  c.eq(parseViewVersions('0.1.0\n0.1.4\n').versions, ['0.1.0', '0.1.4'], '非 JSON 的一行一个版本也能兜住');
  c.eq(parseViewVersions('').ok, false, '空输出 ⇒ 判不了（不是空数组冒充通过）');

  // ── ② 区间内取最高（预发布不算候选）─────────────────────────
  c.eq(pickHighestInRange('^0.1.0', ['0.1.0', '0.1.1', '0.1.4']).best, '0.1.4', '区间内取最高');
  c.eq(pickHighestInRange('^0.1.0', ['0.1.0', '0.2.0-rc.1']).best, '0.1.0', '预发布不当候选');
  c.eq(pickHighestInRange('^0.2.0', ['0.1.0']).ok, false, '区间内一个都没有 ⇒ 判不了（不许静默给空）');

  // ── ③ 解析器：缓存 + 取不到时 unknown ────────────────────────
  {
    const reg = fakeRegistry({ '@fake/a': ['0.1.0', '0.1.4'] });
    const resolver = createRegistryResolver({ run: reg.run });
    const first = await resolver.lookup({ name: '@fake/a', versionRange: '^0.1.0' });
    const again = await resolver.lookup({ name: '@fake/a', versionRange: '^0.1.0' });
    c.eq(first.status, 'ok', '拿到版本列表 ⇒ status=ok');
    c.eq(first.best, '0.1.4', 'best 是区间内最高');
    c.eq(reg.calls.length, 1, '同一个包只查一次（缓存生效）');
    c.eq(again.best, '0.1.4', '第二次走缓存、结果一致');

    const broken = createRegistryResolver({ run: fakeRegistry({}, { fail: 'npm error EAI_AGAIN' }).run });
    const bad = await broken.lookup({ name: '@fake/b', versionRange: '^0.1.0' });
    c.eq(bad.status, 'unknown', '取不到 ⇒ unknown（不是 ok、也不是"通过"）');

    const off = createRegistryResolver({ enabled: false });
    c.eq((await off.lookup({ name: '@fake/b', versionRange: '^0.1.0' })).status, 'skipped', '--no-registry ⇒ skipped');
  }

  // ── ④ verifyItem：区间内但落后 ⇒ 必须判红（本格最重要的一条）────
  {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'registry-verify-'));
    try {
      const home = path.join(dir, 'home');
      const pkgDir = path.join(home, 'profiles', 'fixture', 'node_modules', '@fake', 'lag');
      fs.mkdirSync(pkgDir, { recursive: true });
      writeJson(path.join(pkgDir, 'package.json'), { name: '@fake/lag', version: '0.1.0', dsh: { bundle: { patch: './x.yml' } } });
      const ctx = {
        home,
        profile: 'fixture',
        npmPrefix: path.join(dir, 'npm'),
        registry: createRegistryResolver({ run: fakeRegistry({ '@fake/lag': ['0.1.0', '0.1.4'] }).run }),
        run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      };
      const lagged = await verifyItem(pluginItem('@fake/lag'), ctx);
      const versionCheck = lagged.checks.find((x) => x.label === '版本区间');
      c.eq(versionCheck.status, 'fail', '实体 0.1.0、区间内注册表最高 0.1.4 ⇒ 必须判红');
      c.contains(versionCheck.detail, '落后', '判红的理由要写清"落后"');
      c.contains(versionCheck.detail, '0.1.4', '判红的理由要写出最新合规版是哪个');
      c.eq(lagged.ok, false, '这一项的总结论是不通过（不然整批还会绿）');

      // 同一份判据的正向对照：实体就是最高 ⇒ 绿
      const fresh = {
        ...ctx,
        registry: createRegistryResolver({ run: fakeRegistry({ '@fake/lag': ['0.1.0'] }).run }),
      };
      const okItem = await verifyItem(pluginItem('@fake/lag'), fresh);
      c.eq(okItem.checks.find((x) => x.label === '版本区间').status, 'pass', '实体已是区间内最高 ⇒ 绿');

      // 取不到注册表 ⇒ 仍绿，但必须写明"没核"
      const offline = {
        ...ctx,
        registry: createRegistryResolver({ run: fakeRegistry({}, { fail: 'ETIMEDOUT' }).run }),
      };
      const unknown = await verifyItem(pluginItem('@fake/lag'), offline);
      const uk = unknown.checks.find((x) => x.label === '版本区间');
      c.eq(uk.status, 'pass', '取不到注册表时不假红');
      c.eq(uk.registryStatus, 'unknown', '但要标成 unknown（汇总里会单列"没核过"）');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  // ── ⑤ 端到端：整批真装，落后 ⇒ 退出码不是 0 ────────────────────
  {
    const env = makeFakeEnv({
      profile: 'fixture',
      items: [pluginItem('@fake/plug'), cliItem('@fake/cli-a', 'cli-a')],
    });
    try {
      const reg = fakeRegistry({ '@fake/plug': ['0.1.0', '0.1.4'], '@fake/cli-a': ['0.1.0', '0.1.5'] });
      const res = await env.withPath(() => runSuite(baseOptions(env, { registryRun: reg.run })));
      c.eq(res.exitCode, EXIT.ROLLED_BACK, `装成下界 ⇒ 退出码必须是 3（回滚干净），实际 ${res.exitCode}`);
      c.contains(res.text, '落后', '输出里要能看到"落后"这个结论');
      c.contains(res.text, '0.1.4', '输出里要写出注册表上的最新合规版');

      // 对照：注册表说"就是这个版本" ⇒ 全绿
      const env2 = makeFakeEnv({ profile: 'fixture', items: [pluginItem('@fake/plug')] });
      try {
        const same = fakeRegistry({ '@fake/plug': ['0.1.0'] });
        const okRun = await env2.withPath(() => runSuite(baseOptions(env2, { registryRun: same.run })));
        c.eq(okRun.exitCode, EXIT.OK, '实体就是区间内最高 ⇒ 退出码 0');
        c.contains(okRun.text, '都对着注册表核过', '全绿时要说清核过注册表');
      } finally {
        env2.cleanup();
      }

      // 关掉核对：绿，但汇总必须明说没核
      const env3 = makeFakeEnv({ profile: 'fixture', items: [pluginItem('@fake/plug')] });
      try {
        const offRun = await env3.withPath(() => runSuite(baseOptions(env3, { noRegistry: true })));
        c.eq(offRun.exitCode, EXIT.OK, '--no-registry 时只核区间 ⇒ 0');
        c.contains(offRun.text, '没核"是不是最新合规版"', '关掉核对时必须在汇总里说明白（否则又是假绿）');
        c.eq(offRun.summary.registry.enabled, false, 'summary 里如实标 off');
      } finally {
        env3.cleanup();
      }
    } finally {
      env.cleanup();
    }
  }
}
