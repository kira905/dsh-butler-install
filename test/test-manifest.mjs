// 清单解析与校验：缺字段 / 类型错 / 区间非法 / 重复 / 探针口径 —— 每条错误都要带行号
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, ManifestError } from '../lib/manifest.mjs';
import { selectItems } from '../lib/run.mjs';
import { makeTempDir } from './lib/harness.mjs';

export const name = '清单校验（带文件名+行号）';

function writeManifest(content) {
  const dir = makeTempDir('butler-install-manifest');
  const file = path.join(dir, 'suite-manifest.json');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function lineOf(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`夹具自身的错：找不到锚点 ${needle}`);
  return text.slice(0, at).split(/\r?\n/).length;
}

function expectError(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof ManifestError) return err;
    throw err;
  }
}

const OK = `{
  "schemaVersion": 1,
  "suite": "fixture",
  "items": [
    { "name": "@fake/one", "versionRange": "^0.1.0", "type": "plugin", "group": "核心", "probe": { "kind": "existence" } },
    { "name": "@fake/two", "versionRange": "^0.1.0", "type": "cli", "group": "CLI", "probe": { "kind": "existence", "cmd": "two" } }
  ]
}
`;

export async function run(c) {
  // 1) 合法清单
  const okFile = writeManifest(OK);
  const ok = loadManifest(okFile.file);
  c.eq(ok.items.length, 2, '合法清单应解析出 2 项');
  c.eq(ok.groups, ['核心', 'CLI'], '组名按出现顺序去重');

  // 2) 缺 type：行号要指向那个条目
  const noType = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/one", "versionRange": "^0.1.0", "group": "核心", "probe": { "kind": "existence" } }
  ]
}
`;
  const noTypeErr = expectError(() => loadManifest(writeManifest(noType).file));
  const noTypeIssue = noTypeErr && noTypeErr.issues.find((i) => /type 必须是/.test(i.message));
  c.ok(Boolean(noTypeIssue), '缺 type 必须报错');
  c.eq(noTypeIssue && noTypeIssue.line, lineOf(noType, '"name": "@fake/one"'), '缺 type 的行号要指向该条目');

  // 3) 版本区间非法
  const badRange = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/one", "versionRange": ">=0.1", "type": "plugin", "group": "核心", "probe": { "kind": "existence" } }
  ]
}
`;
  const badRangeErr = expectError(() => loadManifest(writeManifest(badRange).file));
  const badRangeIssue = badRangeErr && badRangeErr.issues.find((i) => /versionRange 非法/.test(i.message));
  c.ok(Boolean(badRangeIssue), '非法版本区间必须报错');
  c.eq(badRangeIssue && badRangeIssue.line, lineOf(badRange, '"name": "@fake/one"'), '非法区间的行号要指向该条目');

  // 4) 类型错（items 不是数组）
  const notArray = `{
  "schemaVersion": 1,
  "items": "nope"
}
`;
  const notArrayErr = expectError(() => loadManifest(writeManifest(notArray).file));
  c.ok(Boolean(notArrayErr && notArrayErr.issues.some((i) => /items 必须是非空数组/.test(i.message))), 'items 类型错必须报错');

  // 5) 重复包名
  const dup = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/one", "versionRange": "^0.1.0", "type": "plugin", "group": "核心", "probe": { "kind": "existence" } },
    { "name": "@fake/one", "versionRange": "^0.1.0", "type": "plugin", "group": "核心", "probe": { "kind": "existence" } }
  ]
}
`;
  const dupErr = expectError(() => loadManifest(writeManifest(dup).file));
  c.ok(Boolean(dupErr && dupErr.issues.some((i) => /重复/.test(i.message))), '重复包名必须报错');

  // 6) cli 缺 probe.cmd
  const noCmd = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/two", "versionRange": "^0.1.0", "type": "cli", "group": "CLI", "probe": { "kind": "existence" } }
  ]
}
`;
  const noCmdErr = expectError(() => loadManifest(writeManifest(noCmd).file));
  c.ok(Boolean(noCmdErr && noCmdErr.issues.some((i) => /probe\.cmd 必填/.test(i.message))), 'cli 缺探针命令必须报错');

  // 7) 标了 help 却没给"核过"的证据
  const helpNoEvidence = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/two", "versionRange": "^0.1.0", "type": "cli", "group": "CLI", "probe": { "kind": "help", "cmd": "two" } }
  ]
}
`;
  const helpNoEvidenceErr = expectError(() => loadManifest(writeManifest(helpNoEvidence).file));
  c.ok(
    Boolean(helpNoEvidenceErr && helpNoEvidenceErr.issues.some((i) => /helpVerified/.test(i.message))),
    '标 help 必须写明"哪条命令、核在哪份源码上"',
  );

  // 8) 标了 cmd 却没写"凭什么只读"
  const cmdNoReason = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/two", "versionRange": "^0.1.0", "type": "cli", "group": "CLI", "probe": { "kind": "cmd", "cmd": "two" } }
  ]
}
`;
  const cmdNoReasonErr = expectError(() => loadManifest(writeManifest(cmdNoReason).file));
  c.ok(
    Boolean(cmdNoReasonErr && cmdNoReasonErr.issues.some((i) => /readonlyBecause/.test(i.message))),
    '标 cmd 必须写清凭什么认定它只读',
  );

  // 9) cli 带 mount 是矛盾的
  const cliMount = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/two", "versionRange": "^0.1.0", "type": "cli", "group": "CLI", "mount": "auto", "probe": { "kind": "existence", "cmd": "two" } }
  ]
}
`;
  const cliMountErr = expectError(() => loadManifest(writeManifest(cliMount).file));
  c.ok(Boolean(cliMountErr && cliMountErr.issues.some((i) => /不该带 mount/.test(i.message))), 'cli 带 mount 必须报错');

  // 10) JSON 语法错也要给行号
  const broken = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/one", }
  ]
}
`;
  const brokenErr = expectError(() => loadManifest(writeManifest(broken).file));
  c.ok(Boolean(brokenErr && brokenErr.issues.length === 1 && brokenErr.issues[0].line >= 1), 'JSON 语法错必须给出一个有效行号');
  c.ok(Boolean(brokenErr && /JSON 解析失败/.test(brokenErr.issues[0].message)), 'JSON 语法错的说明要带"JSON 解析失败"');

  // 11) excluded 的格式
  const badExcluded = `{
  "schemaVersion": 1,
  "items": [
    { "name": "@fake/one", "versionRange": "^0.1.0", "type": "plugin", "group": "核心", "probe": { "kind": "existence" } }
  ],
  "excluded": [ { "id": "x" } ]
}
`;
  const badExcludedErr = expectError(() => loadManifest(writeManifest(badExcluded).file));
  c.ok(Boolean(badExcludedErr && badExcludedErr.issues.some((i) => /excluded/.test(i.message))), 'excluded 缺 reason 必须报错');

  // 12) 真的清单本身必须过校验（防止手改坏）
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const real = loadManifest(path.join(repoRoot, 'suite-manifest.json'));
  c.eq(real.items.length, 16, '随包清单应有 16 项（5 插件 + 11 命令行）');
  c.eq(real.items.filter((i) => i.type === 'plugin').length, 5, '随包清单里插件应为 5 项');
  c.eq(real.items.filter((i) => i.type === 'cli').length, 11, '随包清单里命令行应为 11 项');
  c.ok(real.excluded.length >= 1, '不可安装的聚合仓必须在 excluded 里写明理由');
  c.ok(real.items.every((i) => i.probe && i.probe.kind === 'existence'), '默认探针必须全部是存在性检查（零执行）');

  // 13) --only / --skip 的选择语义
  const sel = selectItems(real, { only: ['面板', '看板'] });
  c.eq(sel.items.map((i) => i.name), ['@kira905/dsh-ecosystem-panel', '@kira905/dsh-board-toolkit'], '别名要能选中对应条目');
  const selGroup = selectItems(real, { only: ['记忆'] });
  c.eq(selGroup.items.map((i) => i.name), ['@kira905/dsh-memory-toolkit'], '组名与别名同名时按"都匹配"处理');
  const selSkip = selectItems(real, { only: ['CLI'], skip: ['看板'] });
  c.ok(!selSkip.items.some((i) => i.name === '@kira905/dsh-board-toolkit'), '--skip 要在 --only 之后再生效');
  const selBad = selectItems(real, { only: ['不存在的名字'] });
  c.ok(selBad.errors.length === 1 && selBad.items.length === 0, '选不中时必须报错而不是静默给空集');

  for (const dir of [okFile.dir]) fs.rmSync(dir, { recursive: true, force: true });
}
