// 真装全绿：插件进组合列表、命令行进全局前缀、第二次跑自动跳过、卸载能卸干净
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, EXIT } from '../lib/run.mjs';
import { makeFakeEnv, pluginItem, cliItem } from './lib/fake-env.mjs';
import { readJsonSafe } from './lib/harness.mjs';

export const name = '真装全绿 + 幂等 + 卸载';

function baseOptions(env, extra = {}) {
  return {
    profile: 'fixture',
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
    ...extra,
  };
}

export async function run(c) {
  const env = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/plug'), cliItem('@fake/cli-a', 'cli-a')],
  });

  const first = await env.withPath(() => runSuite(baseOptions(env)));
  c.eq(first.exitCode, EXIT.OK, '两步都成功时退出码必须是 0');
  c.contains(first.text, '✅ 探针（existence）', '每步之后要打判据的行');

  const profileFile = path.join(env.home, 'profiles', 'fixture', 'package.json');
  const profile = readJsonSafe(profileFile, {});
  c.eq(profile.dependencies['@fake/plug'], '^0.1.0', '插件要落进 profile 的依赖列表');
  c.eq((profile.dsh.profile.bundles || []).includes('@fake/plug'), true, '插件要落进组合列表（不然就是"装了不生效"）');
  c.eq(profile.dependencies['@fake/cli-a'], undefined, '命令行工具不该被塞进 profile');

  const shim = path.join(env.npmPrefix, process.platform === 'win32' ? 'cli-a.cmd' : 'cli-a');
  c.eq(fs.existsSync(shim), true, '命令行工具的可执行文件要落在全局前缀');

  // 快照：开跑前一份 + 每成功一步一份
  const snapRoot = path.join(env.home, 'butler-install', 'snapshots');
  const snapDirs = fs.readdirSync(snapRoot);
  c.eq(snapDirs.length, 1, '一轮只建一个快照根');
  const inner = fs.readdirSync(path.join(snapRoot, snapDirs[0])).sort();
  c.eq(inner, ['after-01', 'after-02', 'pre-run'], '要有开跑前的快照，以及每一步之后各一份');

  // 幂等：再跑一次，全部"已满足"，不再执行任何安装命令
  const second = await env.withPath(() => runSuite(baseOptions(env)));
  c.eq(second.exitCode, EXIT.OK, '第二次跑的退出码仍是 0');
  c.contains(second.text, '已满足', '已满足的项要跳过');
  c.eq(second.summary.installedThisRun.length, 0, '第二次跑不该再装任何东西');

  // 卸载：看"现在装着什么"
  const uninstall = await env.withPath(() => runSuite(baseOptions(env, { uninstall: true })));
  c.eq(uninstall.exitCode, EXIT.OK, '卸载干净的退出码是 0');
  const afterUninstall = readJsonSafe(profileFile, {});
  c.eq(Object.keys(afterUninstall.dependencies || {}).length, 0, '卸载后依赖列表要空');
  c.eq((afterUninstall.dsh.profile.bundles || []).includes('@fake/plug'), false, '卸载后组合列表里不该还有它');
  c.eq(fs.existsSync(shim), false, '卸载后全局前缀里的可执行文件要没了');

  env.cleanup();
}
