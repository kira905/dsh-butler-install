// 组合树解析：出现恰好 1 次才算挂上（撞 id 时宿主不报错，只多一行）
import { analyzeDump, checkMounted, skippedBundlesFromStderr } from '../lib/dump.mjs';

export const name = '组合树计数判据';

const SAMPLE = `# == @deepseek-ai/dsh-base
- id: base
  name: '@deepseek-ai/dsh-base'
- id: session
  name: '@deepseek-ai/dsh-session'
# == @kira905/dsh-one
- id: dsh-one
  name: '@kira905/dsh-one'
`;

export async function run(c) {
  const a = analyzeDump(SAMPLE);
  c.eq(a.bundles, ['@deepseek-ai/dsh-base', '@kira905/dsh-one'], '要认出两个组合头');
  c.eq(a.entries.length, 3, '要认出三个条目');
  c.eq(a.nameCounts.get('@kira905/dsh-one'), 1, '条目 name 计数');

  const good = checkMounted(a, '@kira905/dsh-one');
  c.eq(good.ok, true, '一键一项一 id ⇒ 判挂载成功');
  c.eq(good.bundleLines, 1, '组合头 1 行');

  const absent = checkMounted(a, '@kira905/dsh-absent');
  c.eq(absent.ok, false, '树里没有的包必须判失败');

  // 被 patch 的 bundle 行不能算成"这个包出现了"
  const patched = analyzeDump(`# == @deepseek-ai/dsh-base, patched by @kira905/dsh-one
- id: base
  name: '@deepseek-ai/dsh-base'
`);
  c.eq(patched.bundles, ['@deepseek-ai/dsh-base'], 'patched by 之后的部分不是组合名');
  c.eq(checkMounted(patched, '@kira905/dsh-one').ok, false, '"patched by" 不能冒充这个包已挂载');

  // 撞 id：两行同 id 同 name
  const collide = analyzeDump(`# == @kira905/dsh-one
- id: shared
  name: '@kira905/dsh-one'
- id: shared
  name: '@kira905/dsh-one'
`);
  const collideResult = checkMounted(collide, '@kira905/dsh-one');
  c.eq(collideResult.ok, false, '同一个 id 出现两次必须判失败');
  c.ok(collideResult.problems.some((p) => p.includes('出现 2 次')), '失败说明要写出"出现 2 次"');

  // 双挂（同 name 两条不同 id）
  const doubleMount = analyzeDump(`# == @kira905/dsh-one
- id: one-a
  name: '@kira905/dsh-one'
- id: one-b
  name: '@kira905/dsh-one'
`);
  c.eq(checkMounted(doubleMount, '@kira905/dsh-one').ok, false, '同一个包挂两次必须判失败');

  // ── 子包路径挂载（2026-10-31 真装 dump 原文片段，memory-toolkit 0.2.0）──
  // 修之前这里是 0 命中 ⇒ 用户照清单装这一项每轮白装一遍再被回滚
  const SUBPATH_REAL = `# == @kira905/dsh-memory-toolkit
- id: kira905-memory
  name: '@kira905/dsh-memory-toolkit/dsh-memory-local'
`;
  const subpath = analyzeDump(SUBPATH_REAL);
  const subpathResult = checkMounted(subpath, '@kira905/dsh-memory-toolkit');
  c.eq(subpathResult.ok, true, '子包路径挂载（@scope/pkg/内部模块）必须判挂上');
  c.eq(subpathResult.entryCount, 1, '子包路径：命中条目 1 条');
  c.eq(subpathResult.names, ['@kira905/dsh-memory-toolkit/dsh-memory-local'], '命中条目要报出真实 name（不是拿包名硬套）');
  c.eq(subpathResult.nameCounts, [1], '该 name 在整棵树里恰好 1 次');
  c.eq(subpathResult.idCounts, [1], '该 id 在整棵树里恰好 1 次');
  c.eq(subpathResult.problems, [], '子包路径挂载不该留下任何红字');

  // 老形态不回归：name 精确等于包名
  const legacyExact = analyzeDump(`# == @kira905/dsh-ecosystem-panel
- id: kira905-panel
  name: '@kira905/dsh-ecosystem-panel'
`);
  c.eq(checkMounted(legacyExact, '@kira905/dsh-ecosystem-panel').ok, true, '老形态（name 精确等于包名）不许回归');

  // `/` 边界：前缀必须带 `/` 才算子路径
  const boundaryLonger = analyzeDump(`# == @kira905/dsh-foo
- id: foobar
  name: '@kira905/dsh-foobar'
`);
  const boundaryLongerResult = checkMounted(boundaryLonger, '@kira905/dsh-foo');
  c.eq(boundaryLongerResult.entryCount, 0, '`@kira905/dsh-foobar` 不许命中包 `@kira905/dsh-foo`（前缀必须带 /）');
  c.eq(boundaryLongerResult.ok, false, '撞前缀但没挂上 ⇒ 必须判失败');
  c.ok(boundaryLongerResult.problems.some((p) => p.includes('出现 0 次')), '失败说明要写出"出现 0 次"');

  const boundaryShorter = analyzeDump(`# == @kira905/dsh-foo-bar
- id: foo
  name: '@kira905/dsh-foo'
`);
  c.eq(checkMounted(boundaryShorter, '@kira905/dsh-foo-bar').entryCount, 0, '反向：条目是短名 `@kira905/dsh-foo`，不许当成包 `@kira905/dsh-foo-bar` 的挂载');

  // 同一内部模块挂两次（不同 id）⇒ 仍判红（重复挂载的防线不许拆）
  const subpathDouble = analyzeDump(`# == @kira905/dsh-memory-toolkit
- id: kira905-memory
  name: '@kira905/dsh-memory-toolkit/dsh-memory-local'
- id: kira905-memory-2
  name: '@kira905/dsh-memory-toolkit/dsh-memory-local'
`);
  const subpathDoubleResult = checkMounted(subpathDouble, '@kira905/dsh-memory-toolkit');
  c.eq(subpathDoubleResult.ok, false, '同一内部模块挂两次（id 不同）仍必须判红');
  c.ok(
    subpathDoubleResult.problems.some((p) => p.includes('在整棵树里出现 2 次')),
    '失败说明要写出该 name 在整棵树里出现 2 次',
  );
  c.eq(
    subpathDoubleResult.problems.filter((p) => p.includes('dsh-memory-local')).length,
    1,
    '同一条红只报一次，不刷屏',
  );

  // 一个包有意识地挂两个内部模块：合法形态，不许判死（判据取舍写在报告里）
  const twoModules = analyzeDump(`# == @kira905/dsh-memory-toolkit
- id: kira905-memory
  name: '@kira905/dsh-memory-toolkit/dsh-memory-local'
- id: kira905-memory-cli
  name: '@kira905/dsh-memory-toolkit/cli'
`);
  const twoModulesResult = checkMounted(twoModules, '@kira905/dsh-memory-toolkit');
  c.eq(twoModulesResult.entryCount, 2, '挂两个内部模块：命中条目 2 条');
  c.eq(twoModulesResult.ok, true, '两条 name 各 1 次 ⇒ 合法形态，必须判通过');

  // 三条计数判据要各自独立可触发（否则就是"看起来三条、实际只有一条在干活"）
  // ① 只有"组合头 0 行"错：条目在、name 与 id 都恰好 1 次（包是被别的组合 patch 进去的）
  const bundleOnly = analyzeDump(`# == @deepseek-ai/dsh-base
- id: base
  name: '@deepseek-ai/dsh-base'
- id: dsh-one
  name: '@kira905/dsh-one'
`);
  const bundleOnlyResult = checkMounted(bundleOnly, '@kira905/dsh-one');
  c.eq(bundleOnlyResult.bundleLines, 0, '这一格：组合头 0 行');
  c.eq(bundleOnlyResult.nameCount, 1, '这一格：条目 name 恰好 1 条');
  c.eq(bundleOnlyResult.ok, false, '条目在但没作为组合挂上 ⇒ 必须判失败');

  // ② 只有"条目 name 0 条"错：组合头在、没有同名条目
  const nameOnly = analyzeDump(`# == @kira905/dsh-one
- id: something-else
  name: '@other/thing'
`);
  c.eq(checkMounted(nameOnly, '@kira905/dsh-one').ok, false, '组合头在、条目不在 ⇒ 必须判失败');

  // ③ 只有"同一个 id 出现两次"错：name 只有 1 条，撞的是另一个包的 id
  const idOnly = analyzeDump(`# == @kira905/dsh-one
- id: shared
  name: '@kira905/dsh-one'
- id: shared
  name: '@other/thing'
`);
  const idOnlyResult = checkMounted(idOnly, '@kira905/dsh-one');
  c.eq(idOnlyResult.nameCount, 1, '这一格：条目 name 只有 1 条');
  c.eq(idOnlyResult.idCounts[0], 2, '这一格：共享的那个 id 出现 2 次');
  c.eq(idOnlyResult.ok, false, '撞 id（哪怕撞的是别人的 id）⇒ 必须判失败');
  c.ok(idOnlyResult.problems.some((p) => p.includes('撞 id')), '失败说明要写出"撞 id"');

  // stderr 的跳过提示：只作归因，不当结论
  const skipped = skippedBundlesFromStderr(
    "dsh: warning: skipping profile bundle @kira905/x — declares no dsh.bundle\nother line\n",
  );
  c.eq(skipped.length, 1, '要认出 stderr 里的跳过提示');
  c.eq(skippedBundlesFromStderr('').length, 0, '干净 stderr 不产生归因');
}
