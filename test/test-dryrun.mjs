// 演练档：一条命令都不跑、写盘为零、输出里把"将要跑的"和"判据"都说清
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, EXIT } from '../lib/run.mjs';
import { makeFakeEnv, pluginItem, cliItem } from './lib/fake-env.mjs';
import { fingerprint } from './lib/harness.mjs';

export const name = '演练档零副作用';

export async function run(c) {
  const env = makeFakeEnv({
    profile: 'fixture',
    items: [pluginItem('@fake/plug'), cliItem('@fake/cli-a', 'cli-a')],
    excluded: [{ id: 'fake-aggregate-repo', reason: '仓根没有 package.json，不是可安装的包' }],
  });

  const before = fingerprint(env.home);
  const npmBefore = fingerprint(env.npmPrefix);

  const result = await env.withPath(() => runSuite({
    profile: 'fixture',
    manifest: env.manifestPath,
    apply: false,
    only: [],
    skip: [],
    upgrade: false,
    rollbackMode: 'step',
    uninstall: false,
    npmPrefix: env.npmPrefix,
    home: env.home,
    timeoutMs: 30000,
    budgetMs: 300000,
    json: true,
  }));

  c.eq(result.exitCode, EXIT.OK, '演练档退出码必须是 0');
  c.contains(result.text, '本档 = 演练', '要明说这是演练');
  c.contains(result.text, `dsh plugin --profile fixture add @fake/plug@^0.1.0`, '要打印插件类将要跑的命令（带期望区间）');
  c.contains(result.text, `npm i -g @fake/cli-a@^0.1.0`, '要打印命令行类将要跑的命令（带期望区间）');
  c.contains(result.text, '判据：', '要打印每步拿什么判据');
  c.contains(result.text, 'dump-config', '插件类的判据要写出组合树核对');
  c.contains(result.text, '不可安装项', 'excluded 里的聚合仓要在演练里跳过并写明原因');

  c.eq(fingerprint(env.home), before, '🔴 演练档不许写数据根（指纹必须一模一样）');
  c.eq(fingerprint(env.npmPrefix), npmBefore, '🔴 演练档不许写全局包目录');
  c.eq(fs.existsSync(path.join(env.home, 'profiles')), false, '演练档连 profile 目录都不该建');
  c.eq(fs.existsSync(path.join(env.home, 'butler-install')), false, '演练档不该拍快照');

  // 前置条件缺失：PATH 上根本没有 dsh ⇒ rc 2，且明说缺什么
  const noDsh = await env.withPath(async () => {
    const saved = process.env.PATH;
    const emptyDir = path.join(env.dir, 'empty-path');
    fs.mkdirSync(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;
    try {
      return await runSuite({
        profile: 'fixture',
        manifest: env.manifestPath,
        apply: false,
        only: [],
        skip: [],
        upgrade: false,
        rollbackMode: 'step',
        uninstall: false,
        npmPrefix: env.npmPrefix,
        home: env.home,
        timeoutMs: 30000,
        budgetMs: 300000,
        json: true,
      });
    } finally {
      process.env.PATH = saved;
    }
  });
  c.eq(noDsh.exitCode, EXIT.USAGE, '缺 dsh 时退出码必须是 2（什么都没改）');
  c.contains(noDsh.text, '找不到 dsh', '要明说缺的是 dsh');

  env.cleanup();
}
