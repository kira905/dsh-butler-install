#!/usr/bin/env node
/**
 * 入口：解析参数 → 交给 runSuite。
 * 这里只做三件事：--help / --version 的早退、参数错误转 rc 2、--json 的输出整形。
 * 真正的编排一律在 lib/run.mjs，别把逻辑塞回入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, HELP_TEXT, EXIT } from '../lib/cli-args.mjs';
import { runSuite } from '../lib/run.mjs';
import { runUiCli } from '../lib/ui-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function pkgVersion() {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return json.version;
  } catch {
    return 'unknown';
  }
}

const { options, errors } = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(HELP_TEXT);
  process.exitCode = EXIT.OK;
} else if (options.version) {
  process.stdout.write(`${pkgVersion()}\n`);
  process.exitCode = EXIT.OK;
} else if (errors.length) {
  for (const e of errors) process.stderr.write(`✖ ${e}\n`);
  process.stderr.write('用 --help 看可用参数。\n');
  process.exitCode = EXIT.USAGE;
} else if (options.ui) {
  // 向导页：只读、只绑 127.0.0.1、只有 GET。起完就挂着，Ctrl+C 结束（不留后台服务）
  process.exitCode = await runUiCli(options);
} else {
  const { exitCode, summary } = await runSuite(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ exitCode, ...summary }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n退出码 ${exitCode}：${exitCode === 0 ? '全绿' : exitCode === 3 ? '有步骤失败，已回滚干净' : exitCode === 4 ? '有步骤失败，回滚不干净（要人看）' : '用法/前置条件错误，什么都没改'}\n`);
  }
  process.exitCode = exitCode;
}
