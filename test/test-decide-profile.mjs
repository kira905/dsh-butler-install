// test-decide-profile.mjs —— 默认 profile 的自动判定（2026-11-07 桌面版实测事故的回归夹具）
//
// 为什么要有它：2026-11-07 实测 —— exe 双击（不带 --profile）落在 web，而桌面版只加载 desktop，
// 于是桌面版用户装完界面上一个插件都看不到。根因是自动切换只覆盖「只有 desktop、没有 web」的机器，
// 同机装了 CLI + 桌面版的人两个 profile 都在 ⇒ 不命中 ⇒ 落回 web。
// 下面的用例把「桌面版正在跑就该装 desktop」这条锁住，任何人改回去都会红。
import { decideProfile } from '../lib/plan.mjs';

const DESKTOP_RUNNING = { source: 'process', cliCmd: 'X:\\dsh.cmd', desktopProfileExists: true, detected: true };
const DESKTOP_IDLE = { source: 'known-path', cliCmd: 'X:\\dsh.cmd', desktopProfileExists: true, detected: true };
const NO_DESKTOP = { source: '', cliCmd: '', desktopProfileExists: false, detected: false };

const run1 = (opts) => decideProfile({
  options: { profile: opts.profile ?? 'web', profileExplicit: opts.explicit ?? false },
  home: 'C:/__nonexistent_home__',
  desktop: opts.desktop,
});

export async function run(c) {
  // ① 桌面版正在跑 + web 也存在（本机真实形态）⇒ 必须切 desktop
  {
    const r = run1({ desktop: DESKTOP_RUNNING });
    c.eq(r.profile, 'desktop', '桌面版正在运行 ⇒ 默认切 desktop');
    c.eq(r.source, 'auto-desktop-running', '切档来源标记为 auto-desktop-running');
    c.eq(r.changed, true, '标记为「改过」以便页面提示');
    c.eq(r.notices.length > 0, true, '给出可读提示');
  }

  // ② 用户显式给了 --profile web ⇒ 必须尊重，绝不偷偷改
  {
    const r = run1({ profile: 'web', explicit: true, desktop: DESKTOP_RUNNING });
    c.eq(r.profile, 'web', '显式 --profile web 不被覆盖');
    c.eq(r.source, 'explicit', '来源标记为 explicit');
  }

  // ③ 没有桌面版 ⇒ 保持 web，且不要乱加提示
  {
    const r = run1({ desktop: NO_DESKTOP });
    c.eq(r.profile, 'web', '没有桌面版 ⇒ 保持 web');
    c.eq(r.notices.length, 0, '没有桌面版时不产出提示');
  }

  // ④ 显式 --profile desktop 但找不到自带命令 ⇒ 必须报错（不许硬来）
  {
    const r = run1({ profile: 'desktop', explicit: true, desktop: { ...DESKTOP_IDLE, cliCmd: '' } });
    c.eq(r.profile, 'desktop', '仍返回 desktop（由调用方据 error 拦）');
    c.eq(Boolean(r.error), true, '找不到桌面版自带命令 ⇒ 报错，不静默降级');
  }

  // ⑤ 桌面版装了但没在跑、也没有 web（纯桌面版机器）⇒ 仍然切 desktop（原有行为不许退化）
  {
    const r = run1({ desktop: DESKTOP_IDLE });
    c.eq(r.profile, 'desktop', '只有 desktop profile 的机器仍自动切 desktop');
  }
}
