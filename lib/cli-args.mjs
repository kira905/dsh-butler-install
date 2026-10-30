/**
 * 命令行参数解析。
 *
 * 纪律：**未知参数一律报错退出**。这批命令行工具里有不少"未知参数被忽略、然后照常干活"
 * 的先例 —— 安装器自己绝不能成为同一类东西（写错一个字母就静默跑成别的事，比报错坏得多）。
 */

export const EXIT = {
  OK: 0,
  USAGE: 2,
  ROLLED_BACK: 3,
  UNCLEAN: 4,
};

export const HELP_TEXT = `dsh-butler-install —— 大管家全家桶薄壳安装器

用法：
  dsh-butler-install --profile <profile> [选项]

  --profile <name>        要操作的 profile（必填）。宿主会用它定位 <数据根>/profiles/<name>
  --manifest <path>       清单文件，默认用包内自带的 suite-manifest.json
  --apply                 真装。**不加就是演练档**：只打印将要执行的命令与每步判据，一条命令都不跑
  --only <列表>           只装这些：组名 / 包名 / 别名，逗号分隔，可重复给
  --skip <列表>           跳过这些（同 --only 的写法）
  --upgrade               已满足的项也重跑一遍安装（用于"装过但坏了"的情形）
  --rollback[=step|batch] 失败后怎么回滚：默认 step（只回滚失败那一步），batch 退整批
  --uninstall             把选中的包卸掉（**不是回滚**：卸载看"现在装着什么"，回滚看"这轮做了什么"）
  --npm-prefix <dir>      全局包的落点（默认取 npm 自己的全局前缀；隔离演练时用它）
  --home <dir>            DSH 数据根（默认 $DSH_HOME，再默认 ~/.dsh）
  --timeout <秒>          单步超时，默认 120
  --budget <秒>           整批墙钟上限，默认 300；超了停下并回滚本批
  --snapshot-dir <dir>    快照目录，默认 <数据根>/butler-install/snapshots/<时间戳>
  --json                  只输出一份 JSON 汇总（人读的输出改走 stderr）
  --dry-run               显式写"演练"（与默认行为相同，便于脚本表达意图）
  -h, --help              看这份说明
  -V, --version           看版本号

退出码：
  0  全绿
  2  用法/清单/前置条件错误（什么都没改）
  3  有步骤失败，但已回滚干净
  4  有步骤失败，且回滚不干净（要人看：报告里会指出哪份文件对不上）

只用两个原语：\`dsh plugin --profile <p> add|remove …\` 与 \`npm i -g|npm rm -g …\`。
本工具**不写** dsh.profile.bundles、**不写** cordis.patch.yml、**不碰** node_modules —— 那些是宿主的事。
`;

const VALUE_FLAGS = new Set([
  '--profile',
  '--manifest',
  '--only',
  '--skip',
  '--npm-prefix',
  '--home',
  '--timeout',
  '--budget',
  '--snapshot-dir',
]);

const BOOL_FLAGS = new Set(['--apply', '--upgrade', '--uninstall', '--json', '--dry-run', '--help', '-h', '--version', '-V', '--rollback']);

export function parseArgs(argv) {
  const options = {
    profile: null,
    manifest: null,
    apply: false,
    only: [],
    skip: [],
    upgrade: false,
    rollbackMode: 'step',
    uninstall: false,
    npmPrefix: null,
    home: null,
    timeoutMs: 120000,
    budgetMs: 300000,
    snapshotDir: null,
    json: false,
    help: false,
    version: false,
  };
  const errors = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--rollback') {
      const next = argv[i + 1];
      if (next === 'step' || next === 'batch') {
        options.rollbackMode = next;
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--rollback=')) {
      const value = token.slice('--rollback='.length);
      if (value !== 'step' && value !== 'batch') errors.push(`--rollback 只接受 step 或 batch（现在读到 ${JSON.stringify(value)}）`);
      else options.rollbackMode = value;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const flag = eq >= 0 ? token.slice(0, eq) : token;
      const inlineValue = eq >= 0 ? token.slice(eq + 1) : null;
      if (VALUE_FLAGS.has(flag)) {
        const value = inlineValue !== null ? inlineValue : argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          errors.push(`${flag} 需要一个值`);
          continue;
        }
        if (inlineValue === null) i += 1;
        applyValue(options, flag, value, errors);
        continue;
      }
      if (BOOL_FLAGS.has(flag)) {
        if (inlineValue !== null) errors.push(`${flag} 是开关，不接受值`);
        if (flag === '--apply') options.apply = true;
        if (flag === '--upgrade') options.upgrade = true;
        if (flag === '--uninstall') options.uninstall = true;
        if (flag === '--json') options.json = true;
        if (flag === '--help' || flag === '-h') options.help = true;
        if (flag === '--version' || flag === '-V') options.version = true;
        continue;
      }
      errors.push(`未知参数：${token}（用 --help 看可用参数）`);
      continue;
    }
    if (token === '-h') { options.help = true; continue; }
    if (token === '-V') { options.version = true; continue; }
    errors.push(`多余的位置参数：${token}`);
  }

  if (!options.help && !options.version && !options.profile) errors.push('缺 --profile；用法：dsh-butler-install --profile <name> [--apply]');
  return { options, errors };
}

function applyValue(options, flag, value, errors) {
  if (flag === '--profile') {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) errors.push(`--profile 只接受字母数字与 . _ -（现在读到 ${JSON.stringify(value)}）`);
    options.profile = value;
  } else if (flag === '--manifest') {
    options.manifest = value;
  } else if (flag === '--only') {
    options.only.push(...splitList(value));
  } else if (flag === '--skip') {
    options.skip.push(...splitList(value));
  } else if (flag === '--npm-prefix') {
    options.npmPrefix = value;
  } else if (flag === '--home') {
    options.home = value;
  } else if (flag === '--snapshot-dir') {
    options.snapshotDir = value;
  } else if (flag === '--timeout') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) errors.push(`--timeout 要正数秒（现在读到 ${JSON.stringify(value)}）`);
    else options.timeoutMs = Math.round(n * 1000);
  } else if (flag === '--budget') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) errors.push(`--budget 要正数秒（现在读到 ${JSON.stringify(value)}）`);
    else options.budgetMs = Math.round(n * 1000);
  }
}

function splitList(value) {
  return String(value)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
