/**
 * 解析 `dsh --profile <p> --dump-config` 的输出。
 *
 * 为什么非要数次数、不满足于"抓到那一行就不管了"：组合树里同一份实现被挂两次时，
 * 宿主**不报错**、只是多打一行 —— 用户装完一路绿灯，实际用的是哪一份实现谁也说不清。
 * 所以判据是"出现恰好 1 次"，不是"出现过"。
 *
 * 输出形态（实测）：
 *   # == <bundle 名>                     ← 组合（bundle）级
 *   # == <bundle 名>, patched by <包名>   ← 被 patch 的 bundle，别把这行算成"包里出现了"
 *   - id: <entry id>
 *     name: '<包名 或 内部模块名>'
 *
 * 条目的 name 有两种合法写法：包名本身（`@scope/pkg`），或**子包路径**
 * （`@scope/pkg/内部模块`，实测 memory-toolkit 就是 `@kira905/dsh-memory-toolkit/dsh-memory-local`）。
 * 后者曾被误判成"没挂上"（2026-10-31），匹配规则见 `mountMatches`。
 */
export function analyzeDump(text) {
  const bundles = [];
  const entries = [];
  const idCounts = new Map();
  const nameCounts = new Map();
  let current = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const head = /^# == (.+)$/.exec(line);
    if (head) {
      const first = head[1].split(',')[0].trim();
      if (first) bundles.push(first);
      current = null;
      continue;
    }
    const idLine = /^- id:\s*(.+)$/.exec(line);
    if (idLine) {
      const id = idLine[1].trim();
      current = { id, name: null };
      entries.push(current);
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
      continue;
    }
    const nameLine = /^ {2}name:\s*(.+)$/.exec(line);
    if (nameLine && current && current.name === null) {
      const name = nameLine[1].trim().replace(/^['"]|['"]$/g, '');
      current.name = name;
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      continue;
    }
    // 别的顶级/子级行不改变"当前 entry"，但 `- id:` 之外的新 entry 起点已经处理
  }

  return { bundles, entries, idCounts, nameCounts };
}

/**
 * 一个条目是否属于某个包的挂载。
 *
 * 两种合法形态：
 *   `name: '@scope/pkg'`               ← 包自身当条目（老形态）
 *   `name: '@scope/pkg/内部模块'`      ← 子包路径挂载（宿主认的就是这个，实测
 *                                        `@kira905/dsh-memory-toolkit/dsh-memory-local`）
 * 前缀必须带 `/` 才算子路径：`@scope/dsh-foo` 不许命中包 `@scope/dsh-foo-bar`，
 * 反过来 `@scope/dsh-foobar` 也不许命中包 `@scope/dsh-foo`。
 */
export function mountMatches(entryName, pkgName) {
  if (!entryName || !pkgName) return false;
  return entryName === pkgName || entryName.startsWith(`${pkgName}/`);
}

/**
 * 某个包在组合树里的计数判据。
 *
 * 为什么要数次数：同一份实现被挂两次时宿主**不报错**、只多打一行 —— 用户装完一路
 * 绿灯，实际用的是哪一份谁也说不清。所以防线是"每个 name 在整棵树里恰好 1 次"，
 * 不是"出现过就算"。
 *
 * 为什么命中条目不是"恰好 1 条"：一个包可以**有意识地**挂多个内部模块，那时命中
 * 条目是 2 条以上，每条 name 各 1 次 —— 这是合法形态，不许判死；真该红的是同一个
 * name 出现两次（见上一条）。
 */
export function checkMounted(analysis, pkgName) {
  const bundleLines = analysis.bundles.filter((b) => b === pkgName).length;
  const matching = analysis.entries.filter((e) => mountMatches(e.name, pkgName));
  const names = matching.map((e) => e.name);
  const nameCounts = names.map((n) => analysis.nameCounts.get(n) || 0);
  const ids = matching.map((e) => e.id);
  const idCounts = ids.map((id) => analysis.idCounts.get(id) || 0);
  const problems = [];
  if (bundleLines !== 1) problems.push(`组合头 "# == ${pkgName}" 出现 ${bundleLines} 次（应为 1）（packages: ${analysis.bundles.filter((b)=>b.includes(pkgName)).join(' | ') || '无'}）`);
  if (matching.length === 0) problems.push(`条目 name=${pkgName}（或子包路径 ${pkgName}/<内部模块>）出现 0 次（应至少 1 次）`);
  const blamedNames = new Set();
  for (let i = 0; i < names.length; i += 1) {
    if (nameCounts[i] === 1 || blamedNames.has(names[i])) continue;
    blamedNames.add(names[i]);
    problems.push(`条目 name=${names[i]} 在整棵树里出现 ${nameCounts[i]} 次（应为 1）—— 同一份实现被挂两次时宿主不报错，只多打一行`);
  }
  for (let i = 0; i < ids.length; i += 1) {
    if (idCounts[i] !== 1) problems.push(`条目 id=${ids[i]} 在整棵树里出现 ${idCounts[i]} 次（应为 1）—— 撞 id 时宿主不报错，只静默保留一份`);
  }
  return {
    ok: problems.length === 0,
    bundleLines,
    entryCount: matching.length,
    // 兼容老读数：nameCount 一直表示"命中条目数"，语义没变，只是门槛从 ===1 变成 >=1
    nameCount: matching.length,
    names,
    nameCounts,
    ids,
    idCounts,
    problems,
  };
}

/** dump 的 stderr 里"某个 bundle 被跳过"的行（能归因时为安装器所用） */
export function skippedBundlesFromStderr(stderr) {
  const out = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (/skipping profile bundle|declares no dsh\.bundle/.test(line)) out.push(line.trim());
  }
  return out;
}
