/**
 * 向导页的 HTML（单文件、样式与脚本全内联、零外部资源）。
 *
 * 三条纪律，改这个文件之前先看一眼：
 *  1. **命令字符串只从 state 里读**（服务端已经写好 `data-command`），页面 JS 绝不拼命令。
 *     这里的 JS 只做三件事：复制、重查、把新读数写回同一批 DOM 节点。
 *  2. **不做"必须按 1→2→3"的假仪式**：组件之间没有代码依赖，页面只给建议顺序 + 为什么。
 *  3. 一切内容用 textContent / 属性赋值写入，不拼 innerHTML —— state 里有包名与清单正文，
 *     就算它们被改成怪字符，也不能变成页面上的脚本。
 */

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function typeLabel(type) {
  return type === 'plugin' ? '插件' : '命令行';
}

/** 页面上的时间统一按本地时区印（首屏是服务端渲染的，别让首屏显示 ISO 原文、重查后又变成本地时间） */
function formatStamp(value) {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return String(value || '');
  return t.toLocaleString('zh-CN', { hour12: false });
}

function statusOf(item) {
  if (!item.installed) return { cls: 'badge-bad', text: '未装', hint: '复制命令去终端跑' };
  if (item.inRange === 'unknown') return { cls: 'badge-warn', text: '已装', hint: '版本带预发布后缀，区间不判' };
  if (item.inRange !== 'yes') return { cls: 'badge-warn', text: '已装', hint: '版本不在期望区间内' };
  return { cls: 'badge-ok', text: '已装', hint: item.action === 'skip' ? '会跳过' : '会重跑' };
}

function renderRow(item) {
  const status = statusOf(item);
  const command = item.command || '';
  const copyBtn = command
    ? `<button type="button" class="btn btn-copy" data-copy data-command="${escapeHtml(command)}">复制命令</button>`
    : `<button type="button" class="btn btn-copy" data-copy disabled title="本项已满足：不加 --upgrade 时 CLI 什么都不跑，没有可复制的命令">复制命令</button>`;
  return [
    `<tr data-key="${escapeHtml(item.name)}" data-step="${escapeHtml(item.step)}">`,
    `  <td class="num">${escapeHtml(item.step)}</td>`,
    `  <td class="pkg"><code>${escapeHtml(item.name)}</code>${item.note ? `<div class="note">${escapeHtml(item.note)}</div>` : ''}</td>`,
    `  <td><span class="tag tag-${escapeHtml(item.type)}">${escapeHtml(typeLabel(item.type))}</span></td>`,
    `  <td data-field="status"><span class="badge ${status.cls}">${status.text}</span><span class="hint">${status.hint}</span></td>`,
    `  <td class="mono" data-field="version">${escapeHtml(item.installedVersion || '—')}</td>`,
    `  <td class="mono" data-field="range" title="${escapeHtml(item.rangeText)}">${escapeHtml(item.versionRange)}</td>`,
    '  <td class="ops">',
    `    ${copyBtn}`,
    `    <button type="button" class="btn btn-refresh" data-refresh data-key="${escapeHtml(item.name)}">重查</button>`,
    '  </td>',
    '</tr>',
  ].join('\n');
}

function renderOrder(state) {
  if (!state.order || !state.order.length) return '';
  const steps = state.order.map((entry) => [
    '  <li>',
    `    <span class="step">${escapeHtml(entry.step)}</span>`,
    `    <strong>${escapeHtml(entry.group)}</strong>`,
    `    <span class="why">${escapeHtml(entry.why)}</span>`,
    `    <div class="order-items">${entry.items.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</div>`,
    '  </li>',
  ].join('\n')).join('\n');
  return [
    '<section class="card">',
    '  <h2>建议顺序（不是"必须的顺序"）</h2>',
    `  <ol class="order-list">\n${steps}\n  </ol>`,
    ...state.orderNotes.map((n) => `  <p class="order-note">${escapeHtml(n)}</p>`),
    '</section>',
  ].join('\n');
}

function renderExcluded(state) {
  if (!state.excluded || !state.excluded.length) return '';
  const rows = state.excluded
    .map((e) => `    <li><code>${escapeHtml(e.id)}</code> —— ${escapeHtml(e.reason)}</li>`)
    .join('\n');
  return [
    '<section class="card">',
    '  <h2>不可安装项（清单里写明了原因，演练也会跳过）</h2>',
    `  <ul class="excluded">\n${rows}\n  </ul>`,
    '</section>',
  ].join('\n');
}

const CSS = `
:root{color-scheme:light;--bg:#f6f7fb;--card:#fff;--ink:#1b2330;--muted:#66707f;--line:#e3e7ef;--ok:#0f7b46;--okbg:#e6f5ec;--bad:#a3231f;--badbg:#fdeceb;--warn:#8a5a00;--warnbg:#fdf3e0;--accent:#2f5fd0}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 60px;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1120px;margin:0 auto}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:16px;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 16px;max-width:70em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 16px}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:13px;color:var(--muted);margin:0}
.meta dt{font-weight:600;color:var(--ink)}
.meta dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace}
.banner{border-radius:10px;padding:10px 14px;margin:0 0 16px;font-size:14px;display:none;border:1px solid transparent}
.banner.show{display:block}
.banner.ok{background:var(--okbg);border-color:#b9e3cb;color:var(--ok)}
.banner.bad{background:var(--badbg);border-color:#f4c7c4;color:var(--bad)}
.banner.info{background:#eef2fb;border-color:#cdd9f3;color:#2c3f66}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;letter-spacing:.04em;color:var(--muted);font-weight:600;text-transform:none;white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tbody tr.flash{animation:flash 1.2s ease-out}
@keyframes flash{from{background:#fff8d9}to{background:transparent}}
.num{color:var(--muted);width:2.2em}
.pkg code{font-size:13px}
.note{color:var(--muted);font-size:12px;margin-top:3px;max-width:46em}
.mono,code{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.tag-plugin{border-color:#cdd9f3;background:#eef2fb;color:#2c3f66}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:1px 8px;border-radius:999px;margin-right:6px;white-space:nowrap}
.badge-ok{background:var(--okbg);color:var(--ok)}
.badge-bad{background:var(--badbg);color:var(--bad)}
.badge-warn{background:var(--warnbg);color:var(--warn)}
.hint{font-size:12px;color:var(--muted);white-space:nowrap}
.ops{white-space:nowrap}
.btn{font:inherit;font-size:13px;padding:4px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer;margin-right:6px}
.btn:hover:not(:disabled){border-color:#bcc6d8;background:#f7f9fc}
.btn:disabled{color:#a6adba;cursor:not-allowed;background:#fafbfd}
.btn-refresh{color:var(--accent);border-color:#cdd9f3;background:#f4f7fe}
.token{background:#eaf0ff;color:var(--accent);border-radius:6px;padding:0 6px}
.order-list{list-style:none;margin:0;padding:0}
.order-list li{position:relative;padding:6px 0 14px 34px;border-left:2px solid var(--line);margin-left:11px}
.order-list li:last-child{border-left-color:transparent;padding-bottom:0}
.order-list .step{position:absolute;left:-13px;top:4px;width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}
.order-list .why{display:block;color:var(--muted);font-size:13px;margin-top:2px}
.order-items{margin-top:4px;font-size:12px;color:var(--muted)}
.order-items code{margin-right:10px}
.order-note{font-size:13px;color:var(--muted);margin:12px 0 0}
.order-note strong{color:var(--ink)}
.excluded{margin:0;padding-left:20px;font-size:13px;color:var(--muted)}
.excluded code{color:var(--ink)}
.sec{font-size:13px;color:var(--muted);margin:0}
footer{font-size:12px;color:var(--muted);margin-top:6px}
footer code{background:#eceff5;border-radius:4px;padding:1px 5px}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 12px}
.bar .count{font-size:13px;color:var(--muted)}
.bar .count b{color:var(--ink)}
`;

const SCRIPT = `
(function () {
  'use strict';
  var banner = document.getElementById('banner');
  function setBanner(text, kind) {
    banner.textContent = text;
    banner.className = 'banner show ' + (kind || 'info');
  }
  function clearBanner() {
    banner.className = 'banner';
    banner.textContent = '';
  }
  function statusOf(item) {
    if (!item.installed) return { cls: 'badge-bad', text: '未装', hint: '复制命令去终端跑' };
    if (item.inRange === 'unknown') return { cls: 'badge-warn', text: '已装', hint: '版本带预发布后缀，区间不判' };
    if (item.inRange !== 'yes') return { cls: 'badge-warn', text: '已装', hint: '版本不在期望区间内' };
    return { cls: 'badge-ok', text: '已装', hint: item.action === 'skip' ? '会跳过' : '会重跑' };
  }
  function applyState(state) {
    var rows = document.querySelectorAll('tr[data-key]');
    var byKey = Object.create(null);
    for (var i = 0; i < state.items.length; i += 1) byKey[state.items[i].name] = state.items[i];
    var matched = 0;
    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r];
      var item = byKey[row.getAttribute('data-key')];
      if (!item) continue;
      matched += 1;
      var st = statusOf(item);
      var cell = row.querySelector('[data-field="status"]');
      cell.textContent = '';
      var badge = document.createElement('span');
      badge.className = 'badge ' + st.cls;
      badge.textContent = st.text;
      var hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = st.hint;
      cell.appendChild(badge);
      cell.appendChild(hint);
      row.querySelector('[data-field="version"]').textContent = item.installedVersion || '—';
      row.querySelector('[data-field="range"]').textContent = item.versionRange;
      row.querySelector('[data-field="range"]').setAttribute('title', item.rangeText);
      var copy = row.querySelector('[data-copy]');
      if (item.command) {
        copy.setAttribute('data-command', item.command);
        copy.disabled = false;
        copy.removeAttribute('title');
      } else {
        copy.removeAttribute('data-command');
        copy.disabled = true;
        copy.setAttribute('title', '本项已满足：不加 --upgrade 时 CLI 什么都不跑，没有可复制的命令');
      }
    }
    var counts = state.counts || {};
    var setText = function (key, value) {
      var el = document.querySelector('[data-count="' + key + '"]');
      if (el) el.textContent = String(value);
    };
    setText('install', counts.install);
    setText('skip', counts.skip);
    setText('selected', counts.selected);
    var gen = document.querySelector('[data-generated]');
    if (gen) gen.textContent = new Date(state.generatedAt).toLocaleString('zh-CN', { hour12: false });
    if (matched !== rows.length) {
      setBanner('清单条目变过了（页面 ' + rows.length + ' 行 / 现在 ' + state.items.length + ' 项）：刷新一次页面才对得上。', 'info');
    }
    return matched === rows.length;
  }
  function flash(key) {
    var row = document.querySelector('tr[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    if (!row) return;
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    setTimeout(function () { row.classList.remove('flash'); }, 1300);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok ? undefined : Promise.reject(new Error('浏览器不允许复制'));
  }
  var busy = false;
  function refresh(key) {
    if (busy) return;
    busy = true;
    var buttons = document.querySelectorAll('[data-refresh]');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    setBanner('重查中……（只重跑探测，不改任何状态）', 'info');
    fetch('/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (state) {
        if (!state || state.ok !== true) {
          var why = state && state.errors ? state.errors.join(' / ') : '返回里没有 items';
          setBanner('重查没成：' + why, 'bad');
          return;
        }
        var sameSet = applyState(state);
        if (sameSet) setBanner('重查完成：待装 ' + state.counts.install + ' 项 · 已满足 ' + state.counts.skip + ' 项（' + new Date(state.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) + '）', 'ok');
        if (key) flash(key);
      })
      .catch(function (err) {
        setBanner('重查失败：' + (err && err.message ? err.message : err), 'bad');
      })
      .then(function () {
        for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = false;
        busy = false;
      });
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('button') : null;
    if (!btn) return;
    if (btn.hasAttribute('data-copy')) {
      var cmd = btn.getAttribute('data-command');
      if (!cmd) return;
      copyText(cmd).then(function () {
        var old = btn.textContent;
        btn.textContent = '已复制 ✓';
        setTimeout(function () { btn.textContent = old; }, 1100);
        setBanner('已复制：' + cmd, 'ok');
      }).catch(function () {
        setBanner('复制不了（浏览器拦了剪贴板）：手动选下面这行 —— ' + cmd, 'bad');
      });
    } else if (btn.hasAttribute('data-refresh')) {
      refresh(btn.getAttribute('data-key'));
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') clearBanner();
  });
})();
`;

/**
 * 渲染整页。
 * @param {object} state  lib/plan.mjs#buildSuiteState 给出的 `state`
 * @param {object} [opts] `{ url, token }`：url 打印在页脚（便于用户确认自己连的是哪一个地址）；
 *                        token 内嵌成 `<meta name="install-token">`，页面脚本随 POST 一起发
 *                        （闸 2：令牌只从页面读，绝不拼进 URL —— 拼进 URL 就落进历史记录与代理日志）
 */
export function renderPage(state, opts = {}) {
  const counts = state.counts || { total: 0, selected: 0, install: 0, skip: 0 };
  const rows = (state.items || []).map(renderRow).join('\n');
  const url = opts.url || '';
  const token = typeof opts.token === 'string' ? opts.token : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="install-token" content="${escapeHtml(token)}">
<title>大管家全家桶 · 安装向导（只读）</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>大管家全家桶 · 安装向导（只读）</h1>
  <p class="sub">
    这个页面<span class="token">不执行任何命令</span>：它只告诉你每一项该在终端里跑哪一行（复制走），以及按「重查」再看看现在的状态。
    装还是你自己在终端跑 —— 装什么、成没成，得由安装器当场核对，不让一个网页替你做。
  </p>

  <div id="banner" class="banner"></div>

  <section class="card">
    <dl class="meta">
      <dt>清单</dt><dd>${escapeHtml(state.manifest || '')}</dd>
      <dt>数据根</dt><dd>${escapeHtml(state.home || '')}</dd>
      <dt>profile</dt><dd>${escapeHtml(state.profile || '')}${state.profileExists ? '' : '（尚不存在，真装时由宿主自动创建）'}</dd>
      <dt>全局包落点</dt><dd>${escapeHtml(state.npmPrefix || '')}（来源：${escapeHtml(state.npmPrefixSource || '')}）</dd>
      <dt>本次读数</dt><dd data-generated>${escapeHtml(formatStamp(state.generatedAt))}</dd>
    </dl>
  </section>

${renderOrder(state)}

  <section class="card">
    <h2>清单（共 <span data-count="selected">${escapeHtml(counts.selected)}</span> 项选中 · 待装 <span data-count="install">${escapeHtml(counts.install)}</span> · 已满足 <span data-count="skip">${escapeHtml(counts.skip)}</span>）</h2>
    <div class="bar">
      <button type="button" class="btn btn-refresh" data-refresh data-key="">重查全部</button>
      <span class="count">「重查」按的是同一份 <code>GET /state</code>（整批重探）：清单是一次算出来的，拆开只查一行反而会给出互相矛盾的读数。</span>
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>包名</th>
          <th>类型</th>
          <th>状态</th>
          <th>版本</th>
          <th>期望区间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>

${renderExcluded(state)}

  <section class="card">
    <h2>装完怎么验（想手工核就走这两条，都不用跑 <code>--help</code>）</h2>
    <p class="sec">① 插件类：<code>dsh --profile ${escapeHtml(state.profile || 'web')} --dump-config</code>，在输出里搜 <code># == &lt;包名&gt;</code> —— 恰好 1 次才算真挂上。</p>
    <p class="sec">② 命令行类：看 <code>&lt;全局前缀&gt;/node_modules/&lt;包&gt;/package.json</code> 在不在（只查文件，不执行命令）。</p>
    <p class="sec">③ 想省事的整批自检：<code>node &lt;dsh-butler-core 仓根&gt;/selfcheck-replica.mjs --manifest suite-manifest.json</code>。</p>
  </section>

  <footer>
    安全边界：只绑 <code>127.0.0.1</code>（别的机器连不上）·
    页面自身只发只读请求（<code>GET /</code>、<code>GET /state</code>）·
    服务端的写入口（<code>POST /install/*</code>：预览 / 开始 / 取消 / 撤回）要求<b>安装令牌</b> + <b>同源</b>，没有令牌一律 403；
    这一版页面上还没有安装按钮（下一批上），所以此刻它一条命令都不会被调用${url ? ` · 当前地址 <code>${escapeHtml(url)}</code>` : ''}
  </footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
