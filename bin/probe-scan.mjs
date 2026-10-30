#!/usr/bin/env node
/**
 * 探针取证工具：扫一批包的 `bin` 源文件，逐个命令回答"它到底有没有实现 --help"。
 *
 * 为什么单独做成一条命令：清单里把某一项升级成 `probeKind: "help"` 之前，必须先
 * **按命令**核过。这个判断很容易想当然（"同一个仓里别的命令都有，这个也一定有"），
 * 而错了的后果是探针把 `--help` 当普通参数丢给脚本，脚本照常导出/归档/改状态 ——
 * 那不是"看一眼"，是真干活。所以取证动作要能一条命令重跑、结论能贴进清单。
 *
 * **零执行**：只读文件、只做字符串判断，一个 bin 都不跑。
 *
 * 用法：
 *   dsh-butler-install-probe-scan <目录> [--json] [--depth N]
 *   目录可以是某个包根，也可以是装着多个包根的父目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { hasHelpBranch } from '../lib/probe.mjs';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
  process.stdout.write(`dsh-butler-install-probe-scan —— 只读核对哪些命令真的实现了 --help

用法：
  dsh-butler-install-probe-scan <目录> [--json] [--depth N]

  <目录>      某个包的根目录，或装着多个包根的父目录
  --json      输出一份 JSON（贴进清单/报告用）
  --depth N   往下找 package.json 的层数，默认 3
`);
  process.exitCode = argv.length === 0 ? 2 : 0;
} else {
  const json = argv.includes('--json');
  const depthIndex = argv.indexOf('--depth');
  const maxDepth = depthIndex >= 0 ? Number(argv[depthIndex + 1]) || 3 : 3;
  const root = argv.find((a) => !a.startsWith('--') && a !== String(maxDepth) && a !== argv[depthIndex + 1]);

  if (!root) {
    process.stderr.write('✖ 缺目录参数\n');
    process.exitCode = 2;
  } else {
    const results = scan(path.resolve(root), maxDepth);
    if (json) {
      process.stdout.write(`${JSON.stringify({ root: path.resolve(root), results }, null, 2)}\n`);
    } else {
      process.stdout.write(`扫描根：${path.resolve(root)}\n`);
      process.stdout.write('（只读：一个命令都没执行；结论来自源码静态判断）\n\n');
      for (const r of results) {
        process.stdout.write(`${r.helpBranch ? '✅' : '❌'} ${r.pkg}  ${r.cmd}  →  ${r.file}\n`);
      }
      const yes = results.filter((r) => r.helpBranch).length;
      process.stdout.write(`\n共 ${results.length} 个命令：有 --help 分支 ${yes} 个、没有 ${results.length - yes} 个。\n`);
      process.stdout.write('只有 ✅ 那些才允许在清单里标 probeKind=help；其余一律用 existence（只查文件在不在，零执行）。\n');
    }
    process.exitCode = 0;
  }
}

function scan(dir, maxDepth) {
  const out = [];
  for (const pkgDir of findPackageDirs(dir, maxDepth, 0)) {
    const pkgJson = path.join(pkgDir, 'package.json');
    let json;
    try {
      json = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    } catch {
      continue;
    }
    const bin = json.bin;
    if (!bin) continue;
    const pairs = typeof bin === 'string' ? [[json.name || path.basename(pkgDir), bin]] : Object.entries(bin);
    for (const [cmd, rel] of pairs) {
      const file = path.resolve(pkgDir, rel);
      let source = '';
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        out.push({ pkg: json.name, cmd, file, helpBranch: false, reason: '读不到源文件' });
        continue;
      }
      out.push({ pkg: json.name, cmd, file, helpBranch: hasHelpBranch(source) });
    }
  }
  return out;
}

function findPackageDirs(dir, maxDepth, depth) {
  if (depth > maxDepth) return [];
  const out = [];
  if (fs.existsSync(path.join(dir, 'package.json'))) out.push(dir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    out.push(...findPackageDirs(path.join(dir, entry.name), maxDepth, depth + 1));
  }
  return out;
}
