/**
 * 安装状态的两套徽标 —— **全仓只有这一份实现**。
 *
 * 为什么单独抽出来（方案 §11.6 · S1）：
 *  `ui-page.mjs` 里原来有两份 `statusOf()`：一份给服务端首屏渲染、一份塞在页面脚本里。
 *  加"安装中 / 成功 / 失败"这三个运行态时，两份必然漂移 —— 首屏说"已装"、重查后说"未装"，
 *  用户会以为安装器瞎报。
 *
 * 所以现在的规矩是：
 *  - 服务端用 `statusOf()` 渲染首屏，**并且**把结果作为 `item.status` 一起下发（`decorateState`）；
 *  - 页面脚本**不再自己算**，只读 `item.status` / `item.label` 这两个字段。
 *  ⇒ 想改文案、想加状态，来这里改一处，两处自动一致。
 *
 * 两套徽标是不同的东西，别混：
 *  - `statusOf(item)`   = 「这一项**现在装着没有**」（未装 / 已装 / 版本不在区间…）
 *  - `runLabel(status)` = 「这一轮**跑到它时怎么样**」（待装 / 安装中 / 成功 / 跳过 / 失败 / 已取消）
 */

/** 运行态徽标（进度区与清单表共用） */
export const RUN_LABELS = {
  pending: { cls: 'badge-wait', text: '待装' },
  running: { cls: 'badge-run', text: '安装中' },
  ok: { cls: 'badge-ok', text: '成功' },
  skip: { cls: 'badge-skip', text: '跳过' },
  fail: { cls: 'badge-bad', text: '失败' },
  cancelled: { cls: 'badge-warn', text: '已取消' },
};

export function runLabel(status) {
  return RUN_LABELS[status] || RUN_LABELS.pending;
}

const RUN_HINTS = {
  pending: '还没轮到它',
  running: '正在跑这一步的命令',
  ok: '当场判据过了（不是"命令退出码 0"）',
  skip: '已经满足，这一轮不动它',
  fail: '这一步没成（看下面那行 detail）',
  cancelled: '取消时正跑到它',
};

/**
 * 「现在装着没有」的徽标。
 * `item.run` 存在时优先（同一行既可能"已装"、也可能"这一轮刚把它装成/装坏"）。
 */
export function statusOf(item) {
  if (!item || typeof item !== 'object') return { cls: 'badge-bad', text: '未装', hint: '读数缺失' };
  if (item.run && RUN_LABELS[item.run]) {
    return { cls: RUN_LABELS[item.run].cls, text: RUN_LABELS[item.run].text, hint: RUN_HINTS[item.run] || '' };
  }
  if (!item.installed) return { cls: 'badge-bad', text: '未装', hint: '这一项可以装（点【开始安装】）' };
  if (item.inRange === 'unknown') return { cls: 'badge-warn', text: '已装', hint: '版本带预发布后缀，区间不判' };
  if (item.inRange !== 'yes') return { cls: 'badge-warn', text: '已装', hint: '版本不在期望区间内' };
  return { cls: 'badge-ok', text: '已装', hint: item.action === 'skip' ? '这一轮会跳过' : '这一轮会重跑' };
}

/** 把 `statusOf` 的结果塞进 state 再下发 —— 页面脚本只读不算（这就是"同源"） */
export function decorateState(state) {
  if (!state || !Array.isArray(state.items)) return state;
  return {
    ...state,
    items: state.items.map((item) => ({ ...item, status: statusOf(item) })),
  };
}
