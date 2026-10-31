/**
 * 向导页的 HTML（单文件、样式与脚本全内联、零外部资源）。
 *
 * 四条纪律，改这个文件之前先看一眼：
 *  1. **命令字符串只从服务端来**：单条命令来自 `state.items[i].command`，整批命令来自
 *     `preview.equivalentCommand`（**带 `--apply`**）。页面 JS 绝不自己拼命令 ——
 *     拼出来的那条和安装器真跑的必然不是同一条。
 *  2. **状态文案不算在页面里**：`statusOf()` 只存在于 `lib/item-status.mjs` 一处，
 *     服务端算好随 `state`（`item.status`）与 `progress`（`item.label`）一起下发，
 *     页面脚本只读不算（方案 §11.6 · S1：两份实现必然漂移）。
 *  3. **不做"必须按 1→2→3"的假仪式**：组件之间没有代码依赖，页面只给建议顺序 + 为什么。
 *  4. 一切内容用 textContent / 属性赋值写入，不拼 innerHTML —— state 里有包名与清单正文，
 *     就算它们被改成怪字符，也不能变成页面上的脚本。
 *
 * 这一版和 0.2.x 的"只读页"最大的不同：**页面能真装**。
 * 所以文案必须同时说清两件事：①点了才装、不点不装；②安全边界到哪为止（见页脚）。
 */
import { statusOf } from './item-status.mjs';

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
    `  <td data-field="status"><span class="badge ${status.cls}">${status.text}</span><span class="hint">${escapeHtml(status.hint)}</span></td>`,
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

/** 前置条件：这两条不满足，后面全白搭 —— 所以摆在最上面，而不是藏在页脚 */
function renderPrereq() {
  return [
    '<section class="card prereq">',
    '  <h2>开始之前：两个前提</h2>',
    '  <ul>',
    '    <li><b>要有 Node.js 22 或更新</b>。这个安装器自己就是个 node 脚本：没有 node 它连页面都起不来'
    + '（双击那个 <code>.cmd</code> 会告诉你"没找到 node"并给你下载地址）。下载地址：<code>https://nodejs.org/en/download</code></li>',
    '    <li><b>要已经装好 DSH</b>。🔴 <b>本工具不装 DSH</b>，也不装 node —— 它只往你<b>已有</b>的 DSH 里装插件与命令行工具。</li>',
    '  </ul>',
    '  <p class="sec">下面那张表读的是你这台机器上的真实数据根：只看文件、不执行命令、不写一个字节。</p>',
    '</section>',
  ].join('\n');
}

const CSS = `
:root{color-scheme:light;--bg:#f6f7fb;--card:#fff;--ink:#1b2330;--muted:#66707f;--line:#e3e7ef;--ok:#0f7b46;--okbg:#e6f5ec;--bad:#a3231f;--badbg:#fdeceb;--warn:#8a5a00;--warnbg:#fdf3e0;--accent:#2f5fd0;--run:#1f4fa8;--runbg:#e8efff}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 60px;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1120px;margin:0 auto}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:16px;margin:0 0 12px}
h3{font-size:15px;margin:16px 0 8px}
h4{font-size:14px;margin:14px 0 6px;color:var(--muted)}
.sub{color:var(--muted);margin:0 0 16px;max-width:70em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 16px}
.prereq{background:#fbfcff;border-color:#dce5f7}
.prereq ul{margin:0 0 10px;padding-left:20px}
.prereq li{margin:4px 0}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:13px;color:var(--muted);margin:0}
.meta dt{font-weight:600;color:var(--ink)}
.meta dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace}
.banner{border-radius:10px;padding:10px 14px;margin:0 0 16px;font-size:14px;display:none;border:1px solid transparent;white-space:pre-wrap}
.banner.show{display:block}
.banner.ok{background:var(--okbg);border-color:#b9e3cb;color:var(--ok)}
.banner.bad{background:var(--badbg);border-color:#f4c7c4;color:var(--bad)}
.banner.warn{background:var(--warnbg);border-color:#f0dcb4;color:var(--warn)}
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
.badge-run{background:var(--runbg);color:var(--run)}
.badge-wait{background:#f1f2f6;color:var(--muted)}
.badge-skip{background:#f1f2f6;color:var(--muted)}
.hint{font-size:12px;color:var(--muted);white-space:normal}
.ops{white-space:nowrap}
.btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer;margin-right:6px}
.btn:hover:not(:disabled){border-color:#bcc6d8;background:#f7f9fc}
.btn:disabled{color:#a6adba;cursor:not-allowed;background:#fafbfd}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;padding:8px 18px}
.btn-primary:hover:not(:disabled){background:#264fae;border-color:#264fae;color:#fff}
.btn-danger{color:var(--bad);border-color:#f0c4c1;background:#fff6f5}
.btn-refresh{color:var(--accent);border-color:#cdd9f3;background:#f4f7fe}
.token{background:#eaf0ff;color:var(--accent);border-radius:6px;padding:0 6px}
.confirm{border-top:1px solid var(--line);margin-top:14px;padding-top:6px}
.confirm-items{margin:0;padding-left:22px;font-size:13px}
.confirm-items li{margin:2px 0}
.confirm-items .g{color:var(--muted)}
.confirm-actions{margin-top:16px}
.equiv{background:#f7f9fc;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:14px 0 4px}
.equiv-head{font-size:12px;color:var(--muted);margin-bottom:6px}
.equiv code{display:block;font-size:13px;word-break:break-all;margin:0 0 8px;color:var(--ink)}
.gauge{height:8px;background:#e9edf5;border-radius:999px;overflow:hidden;width:260px;max-width:50vw}
.gauge-fill{height:100%;width:0;background:var(--run);transition:width .25s ease}
.run-note{font-size:13px;margin:10px 0 4px;white-space:pre-wrap}
.run-note.bad{color:var(--bad)}
.run-note.ok{color:var(--ok)}
table.prog td{font-size:13px}
.run-actions{margin-top:14px}
.restart{margin-top:16px;border:1px solid #b9e3cb;background:var(--okbg);border-radius:10px;padding:12px 14px;color:#0d5f36}
.restart b{font-size:15px}
.restart div{margin-top:6px;font-size:13px;color:#14663c}
.log-box{margin-top:14px;font-size:13px;color:var(--muted)}
.log-box summary{cursor:pointer}
.log-box pre{max-height:260px;overflow:auto;background:#0f1724;color:#cfe1f7;border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.rb{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:820px){.rb{grid-template-columns:1fr}}
.rb-item{border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.rb-item p{font-size:13px;margin:8px 0 0}
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
footer{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.8}
footer code{background:#eceff5;border-radius:4px;padding:1px 5px}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 12px}
.bar .count{font-size:13px;color:var(--muted)}
.bar .count b{color:var(--ink)}
`;

const SCRIPT = `
(function () {
  'use strict';
  var tokenMeta = document.querySelector('meta[name="install-token"]');
  var TOKEN = tokenMeta ? (tokenMeta.getAttribute('content') || '') : '';
  var banner = document.getElementById('banner');
  var busy = false;
  var polling = false;
  var timer = null;

  function el(id) { return document.getElementById(id); }
  function show(node, on) { if (node) node.hidden = !on; }
  function setText(node, value) { if (node) node.textContent = value; }
  function setBanner(text, kind) {
    banner.textContent = text;
    banner.className = 'banner show ' + (kind || 'info');
  }
  function clearBanner() {
    banner.className = 'banner';
    banner.textContent = '';
  }

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-install-token': TOKEN },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!data) data = { ok: false, error: 'bad-json', message: String(text).slice(0, 400) };
        return { status: res.status, data: data };
      });
    });
  }

  function setBusy(on) {
    busy = on === true;
    // 【取消】的可用性由进度读数说了算（renderProgress 里按 can.cancel 设），不归这里管
    var buttons = document.querySelectorAll('button[data-action]:not([data-action="cancel"])');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = busy;
  }

  // ── 第一步：算一遍（不装） ──────────────────────────────
  function preview() {
    setBusy(true);
    setBanner('正在算一遍：这一步只算不做 —— 一条命令都不跑、一个文件都不写。', 'info');
    api('/install/preview').then(function (r) {
      if (r.status !== 200 || !r.data.ok) {
        var why = r.data.message || (r.data.errors && r.data.errors.join(' / ')) || r.data.error || ('HTTP ' + r.status);
        setBanner('算不出来：' + why, 'bad');
        return;
      }
      renderConfirm(r.data);
      show(el('confirm-box'), true);
      show(el('install-actions'), false);
      setBanner('算好了。下面写的就是点了【确认，开始】之后会做的事；现在还没动任何东西。', 'info');
    }).catch(function (err) {
      setBanner('请求没发出去：' + (err && err.message ? err.message : err), 'bad');
    }).then(function () { setBusy(false); });
  }

  function renderConfirm(p) {
    setText(el('c-profile'), p.profile || '—');
    setText(el('c-counts'), '要装 ' + (p.willInstall ? p.willInstall.length : 0) + ' 项 · 已满足跳过 ' + (p.skipped ? p.skipped.length : 0) + ' 项 · 清单共 ' + ((p.items && p.items.length) || 0) + ' 项');
    setText(el('c-estimate'), (p.estimate && p.estimate.text) || '—');
    var minutes = p.budgetMs ? Math.round(p.budgetMs / 60000) : 0;
    setText(el('c-budget'), minutes ? ('整批最多跑 ' + minutes + ' 分钟，超了就停下并回滚本批') : '—');
    setText(el('c-snapshot'), p.snapshotHint || '—');
    setText(el('c-note'), p.note || '');
    var list = el('c-items');
    while (list.firstChild) list.removeChild(list.firstChild);
    var items = p.items || [];
    setText(el('c-total'), String(items.length));
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i];
      var li = document.createElement('li');
      var name = document.createElement('code');
      name.textContent = it.name;
      li.appendChild(name);
      var tail = document.createElement('span');
      tail.className = 'g';
      tail.textContent = ' · ' + it.group + ' · ' + (it.type === 'plugin' ? '插件' : '命令行')
        + ' · ' + (it.action === 'install' ? '会装' : '已满足，跳过');
      li.appendChild(tail);
      list.appendChild(li);
    }
    var cmd = p.equivalentCommand || '（这一批没有要装的项，也就没有对应的命令）';
    setText(el('c-command'), cmd);
    var copyBtn = document.querySelector('[data-copy-batch]');
    if (copyBtn) copyBtn.setAttribute('data-command', cmd);
  }

  // ── 第二步：真装 ────────────────────────────────────────
  function start() {
    setBusy(true);
    setBanner('开跑了：进度会自己刷新（每 0.8 秒问一次）。装的过程中别关这个页面。', 'info');
    api('/install/start', { confirm: true }).then(function (r) {
      if (r.status === 202) {
        show(el('confirm-box'), false);
        show(el('install-card'), true);
        show(el('run-card'), true);
        startPolling();
        return;
      }
      if (r.status === 409 && r.data.progress) {
        show(el('run-card'), true);
        renderProgress(r.data.progress);
        startPolling();
        setBanner('已经有一批在跑了（同一时刻只许一批）—— 跟着看进度就行。', 'info');
        return;
      }
      var why = r.data.message || r.data.error || ('HTTP ' + r.status);
      setBanner('没开始：' + why, 'bad');
      show(el('install-actions'), true);
    }).catch(function (err) {
      setBanner('请求没发出去：' + (err && err.message ? err.message : err), 'bad');
    }).then(function () { setBusy(false); });
  }

  function stopPolling() {
    polling = false;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    tick();
  }

  function tick() {
    if (!polling) return;
    fetch('/install/progress', { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (p) {
        if (!p || p.ok !== true) {
          stopPolling();
          setBanner('进度读不出来：' + ((p && (p.message || p.error)) || '返回里没有 status'), 'bad');
          return;
        }
        renderProgress(p);
        if (p.status === 'running' || p.status === 'cancelling' || p.status === 'rolling-back') {
          timer = setTimeout(tick, 800);
        } else {
          stopPolling();
          onSettled(p);
        }
      })
      .catch(function () {
        // 一次读不到不算失败：这个页面可能正好在服务重启的空档里
        timer = setTimeout(tick, 1500);
      });
  }

  function renderProgress(p) {
    show(el('run-card'), true);
    var total = p.total || 0;
    var done = 0;
    var items = p.items || [];
    for (var i = 0; i < items.length; i += 1) {
      var st = items[i].status;
      if (st && st !== 'pending' && st !== 'running') done += 1;
    }
    var gauge = el('run-gauge');
    if (gauge) gauge.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    setText(el('run-count'), total ? ('第 ' + Math.min(p.index || 0, total) + '/' + total + ' 步 · 已完成 ' + done) : '还没开跑');
    if (p.current && p.current.name) setText(el('run-headline'), '正在装：' + p.current.name);
    else if (p.status === 'running') setText(el('run-headline'), '安装中');
    else if (p.status === 'done') setText(el('run-headline'), '装完了');
    else if (p.status === 'cancelled' || p.status === 'cancelling') setText(el('run-headline'), '已取消，装了一半');

    var body = el('prog-body');
    while (body.firstChild) body.removeChild(body.firstChild);
    for (var j = 0; j < items.length; j += 1) {
      var it = items[j];
      var label = it.label || { cls: 'badge-wait', text: it.status || '待装' };
      var tr = document.createElement('tr');
      var c1 = document.createElement('td'); c1.className = 'num'; c1.textContent = String(it.index);
      var c2 = document.createElement('td');
      var code = document.createElement('code'); code.textContent = it.name;
      c2.appendChild(code);
      var c3 = document.createElement('td');
      var badge = document.createElement('span'); badge.className = 'badge ' + label.cls; badge.textContent = label.text;
      c3.appendChild(badge);
      var c4 = document.createElement('td'); c4.className = 'hint'; c4.textContent = it.detail || '';
      tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4);
      body.appendChild(tr);
      mergeRow(it.name, label, it.detail || '');
    }

    var note = el('run-note');
    if (note) {
      var lines = [p.message || ''];
      if (p.quietFor60s) lines.push('⏳ 这一项已经 60 秒没输出了 —— npm 静默下载时正常，不是卡死（真卡住会有超时上限）。');
      note.textContent = lines.filter(Boolean).join('\\n');
      note.className = 'run-note ' + (p.status === 'failed' || p.status === 'error' ? 'bad' : (p.status === 'done' ? 'ok' : ''));
    }
    var log = el('run-log');
    if (log) log.textContent = (p.lines || []).join('\\n');
    var cancelBtn = el('btn-cancel');
    if (cancelBtn) cancelBtn.disabled = !(p.can && p.can.cancel) || busy;
    if (p.status === 'done') show(el('restart-box'), true);
  }

  function mergeRow(name, label, detail) {
    var row = null;
    var all = document.querySelectorAll('tr[data-key]');
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].getAttribute('data-key') === name) { row = all[i]; break; }
    }
    if (!row) return;
    setStatusCell(row, label.cls, label.text, detail || '');
  }

  function setStatusCell(row, cls, text, hint) {
    var cell = row.querySelector('[data-field="status"]');
    if (!cell) return;
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    var badge = document.createElement('span');
    badge.className = 'badge ' + cls;
    badge.textContent = text;
    var span = document.createElement('span');
    span.className = 'hint';
    span.textContent = hint;
    cell.appendChild(badge);
    cell.appendChild(span);
  }

  function onSettled(p) {
    show(el('rollback-card'), Boolean(p.result) || p.status === 'cancelled' || p.status === 'failed');
    // 这一批结束了就把【开始安装】放回来：卸完之后想重装一遍，不该逼人刷新页面
    show(el('install-actions'), true);
    if (p.status === 'done') {
      setBanner('装完了。⑥ 最后一步：要重启 DSH，插件才会出现在侧边栏（见下面那块绿框）。', 'ok');
      // 装完之后重读一次清单：版本列与"待装/已满足"计数要跟着变过来，不然页面还挂着开跑前的读数
      refreshTable();
      return;
    }
    if (p.status === 'cancelled') {
      setBanner('已取消，装了一半。已经装好的项留着；要让它们真的变回"未装"，用下面的【卸载这次装的】。', 'warn');
      return;
    }
    if (p.status === 'failed') {
      setBanner('这一批有失败项（看下面每行的"说明"）。按设定回滚了这一步之前，报告里写着回滚干净了没有。', 'bad');
      return;
    }
    if (p.status === 'error') {
      setBanner('安装器自己抛错了：这一批的结果不可信，请照下面的日志排查。', 'bad');
    }
  }

  function cancel() {
    setBusy(true);
    api('/install/cancel').then(function (r) {
      var d = r.data || {};
      if (r.status === 202 || r.status === 200) {
        setBanner(d.message || '正在停：在杀当前那条命令的进程树。', 'warn');
      } else {
        setBanner('取消没成：' + (d.message || d.error || ('HTTP ' + r.status)), 'bad');
      }
    }).catch(function (err) {
      setBanner('请求没发出去：' + (err && err.message ? err.message : err), 'bad');
    }).then(function () { setBusy(false); });
  }

  function doRollback(kind) {
    var name = kind === 'uninstall' ? '卸载这次装的' : '只恢复配置文件到装前';
    setBusy(true);
    setBanner('正在' + name + '……', 'info');
    api('/install/rollback', { action: kind }).then(function (r) {
      var d = r.data || {};
      if (r.status === 200 && d.ok) {
        var tail = d.text || d.honest || d.warning || '';
        setBanner(name + '：成了。' + (tail ? '\\n它自己的话：' + tail : ''), 'ok');
        // 撤完之后重读一次清单：让"已装 / 未装"当场变过来（这才是那条判据）
        refreshTable();
        return;
      }
      if (r.status === 412) {
        setBanner('拒动（这是设计）：' + (d.message || d.reason || '前置核对没过') + (d.hint ? '\\n—— ' + d.hint : ''), 'bad');
        return;
      }
      setBanner(name + '：没成。' + (d.message || d.error || ('HTTP ' + r.status)), 'bad');
    }).catch(function (err) {
      setBanner('请求没发出去：' + (err && err.message ? err.message : err), 'bad');
    }).then(function () { setBusy(false); });
  }

  // ── 清单表：重查 / 复制 ────────────────────────────────
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
      // 🔴 状态文案由服务端算好下发（item.status）：页面只认不算，免得两份实现漂移
      var st = item.status || { cls: 'badge-bad', text: '未装', hint: '' };
      setStatusCell(row, st.cls, st.text, st.hint || '');
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
    var setCount = function (key, value) {
      var node = document.querySelector('[data-count="' + key + '"]');
      if (node) node.textContent = String(value);
    };
    setCount('install', counts.install);
    setCount('skip', counts.skip);
    setCount('selected', counts.selected);
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

  function copyText(textValue) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(textValue).catch(function () { return legacyCopy(textValue); });
    }
    return legacyCopy(textValue);
  }

  function legacyCopy(textValue) {
    var ta = document.createElement('textarea');
    ta.value = textValue;
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

  var refreshing = false;
  function refreshTable() {
    return fetch('/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (state) {
        if (!state || state.ok !== true) {
          var why = state && state.errors ? state.errors.join(' / ') : '返回里没有 items';
          setBanner('重查没成：' + why, 'bad');
          return null;
        }
        var sameSet = applyState(state);
        return { state: state, sameSet: sameSet };
      });
  }

  function refresh(key) {
    if (refreshing) return;
    refreshing = true;
    var buttons = document.querySelectorAll('[data-refresh]');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    setBanner('重查中……（只重跑探测，不改任何状态）', 'info');
    refreshTable().then(function (out) {
      if (!out) return;
      if (out.sameSet) {
        var s = out.state;
        setBanner('重查完成：待装 ' + s.counts.install + ' 项 · 已满足 ' + s.counts.skip + ' 项（' + new Date(s.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) + '）', 'ok');
      }
      if (key) flash(key);
    }).catch(function (err) {
      setBanner('重查失败：' + (err && err.message ? err.message : err), 'bad');
    }).then(function () {
      for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = false;
      refreshing = false;
    });
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('button') : null;
    if (!btn || btn.disabled) return;

    if (btn.hasAttribute('data-copy') || btn.hasAttribute('data-copy-batch')) {
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
      return;
    }
    if (btn.hasAttribute('data-refresh')) { refresh(btn.getAttribute('data-key')); return; }

    var action = btn.getAttribute('data-action');
    if (!action) return;
    if (action === 'preview') preview();
    else if (action === 'start') start();
    else if (action === 'dismiss') {
      show(el('confirm-box'), false);
      show(el('install-actions'), true);
      setBanner('好，什么都没动。想装的时候再点【开始安装】。', 'info');
    } else if (action === 'cancel') cancel();
    else if (action === 'rollback-uninstall') doRollback('uninstall');
    else if (action === 'rollback-restore') doRollback('restore-declarations');
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') clearBanner();
  });
})();
`;

/**
 * 渲染整页。
 * @param {object} state  lib/plan.mjs#buildSuiteState 给出的 `state`（已经过 lib/item-status.mjs#decorateState）
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
<title>大管家全家桶 · 安装向导</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>大管家全家桶 · 安装向导</h1>
  <p class="sub">
    这个页面<b>能装</b>：按下【开始安装】只是算一遍要做什么，再按【确认，开始】才真装。
    <span class="token">不点确认，一条命令都不会跑</span>。
    装完记得重启 DSH —— 插件要重启才会出现在侧边栏。
  </p>

  <div id="banner" class="banner"></div>

${renderPrereq()}

  <section class="card" id="install-card">
    <h2>装</h2>
    <div id="install-actions">
      <button type="button" class="btn btn-primary" data-action="preview">开始安装</button>
      <span class="count">先算一遍：要装哪些、装到哪个 profile、回滚点拍在哪 —— <b>那一步一条命令都不跑</b>。</span>
    </div>
    <div id="confirm-box" class="confirm" hidden>
      <h3>按【确认，开始】之后，会做这些事</h3>
      <dl class="meta">
        <dt>目标 profile</dt><dd id="c-profile">—</dd>
        <dt>要装 / 跳过</dt><dd id="c-counts">—</dd>
        <dt>预计时长</dt><dd id="c-estimate">—</dd>
        <dt>墙钟上限</dt><dd id="c-budget">—</dd>
        <dt>回滚点（快照拍在这）</dt><dd id="c-snapshot">—</dd>
      </dl>
      <h4>逐项清单（<span id="c-total">0</span> 项）</h4>
      <ol id="c-items" class="confirm-items"></ol>
      <p class="sec" id="c-note"></p>
      <div class="equiv">
        <div class="equiv-head">同一件事的命令行版本 —— 想自己在终端跑就用这条。<b>它带 <code>--apply</code></b>：不加 <code>--apply</code> 的那条只是演练，跑完什么都不装。</div>
        <code id="c-command">—</code>
        <button type="button" class="btn" data-copy-batch data-command="">复制这条</button>
      </div>
      <div class="confirm-actions">
        <button type="button" class="btn btn-primary" data-action="start">确认，开始</button>
        <button type="button" class="btn" data-action="dismiss">先不装</button>
      </div>
    </div>
  </section>

  <section class="card" id="run-card" hidden>
    <h2 id="run-headline">安装进度</h2>
    <div class="bar">
      <div class="gauge"><div class="gauge-fill" id="run-gauge"></div></div>
      <span class="count" id="run-count"></span>
    </div>
    <p class="run-note" id="run-note"></p>
    <table class="prog">
      <thead><tr><th>#</th><th>包名</th><th>状态</th><th>说明</th></tr></thead>
      <tbody id="prog-body"></tbody>
    </table>
    <div class="run-actions">
      <button type="button" class="btn btn-danger" data-action="cancel" id="btn-cancel">取消</button>
      <span class="count">取消 = 杀掉当前那条命令的进程树。<b>已经装好的项会留着</b>，这不是整批干净回滚。</span>
    </div>
    <div id="restart-box" class="restart" hidden>
      <b>⑥ 最后一步：要重启 DSH，插件才会出现在侧边栏。</b>
      <div>插件这会儿已经在 profile 里了，但宿主只在启动时读一次组合列表 —— 不重启，侧边栏不会多出任何东西。这是最容易让人以为"装了没用、被骗了"的地方。</div>
      <div>怎么重启：关掉 DSH 的那个窗口，再双击 <code>dsh-start.cmd</code>（或者跑一次 <code>dsh-restart.ps1</code>）。</div>
    </div>
    <details class="log-box" id="log-box">
      <summary>看安装器自己的日志（最多留最近 60 行摘要）</summary>
      <pre id="run-log"></pre>
    </details>
  </section>

  <section class="card" id="rollback-card" hidden>
    <h2>不满意？两条撤回，区别很大，别点错</h2>
    <div class="rb">
      <div class="rb-item">
        <button type="button" class="btn btn-primary" data-action="rollback-uninstall">卸载这次装的</button>
        <p><b>推荐。</b>真的把这一轮装上去的卸掉：插件从 profile 里摘下来，全局命令行包从全局前缀里删掉。卸完重查，状态会真的变回"未装"。</p>
        <p class="sec">它只看"这一轮装成了什么"，<b>不覆盖任何文件</b> —— 所以你随后在 DSH 侧边栏另装的插件不受影响。</p>
      </div>
      <div class="rb-item">
        <button type="button" class="btn" data-action="rollback-restore">只恢复配置文件到装前</button>
        <p><b>只还声明层</b>（<code>package.json</code> / <code>pnpm-lock.yaml</code> / <code>cordis.patch.yml</code> / <code>pnpm-workspace.yaml</code>）到开跑前那一份。<b><code>node_modules</code> 里的实体文件与全局 CLI 包还在</b>，所以重开会显示"已装"。</p>
        <p class="sec">🔴 如果这期间有别的程序（比如正在跑的 DSH 宿主）改过这几份文件，它会<b>拒动</b>并告诉你是哪一份对不上 —— 那种情况请用上面那个【卸载这次装的】。</p>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>清单（共 <span data-count="selected">${escapeHtml(counts.selected)}</span> 项选中 · 待装 <span data-count="install">${escapeHtml(counts.install)}</span> · 已满足 <span data-count="skip">${escapeHtml(counts.skip)}</span>）</h2>
    <div class="bar">
      <button type="button" class="btn btn-refresh" data-refresh data-key="">重查全部</button>
      <span class="count">「重查」按的是同一份 <code>GET /state</code>（整批重探）：清单是一次算出来的，拆开只查一行反而会给出互相矛盾的读数。</span>
    </div>
    <dl class="meta" style="margin-bottom:12px">
      <dt>清单</dt><dd>${escapeHtml(state.manifest || '')}</dd>
      <dt>数据根</dt><dd>${escapeHtml(state.home || '')}</dd>
      <dt>profile</dt><dd>${escapeHtml(state.profile || '')}${state.profileExists ? '' : '（尚不存在，真装时由宿主自动创建）'}</dd>
      <dt>全局包落点</dt><dd>${escapeHtml(state.npmPrefix || '')}（来源：${escapeHtml(state.npmPrefixSource || '')}）</dd>
      <dt>本次读数</dt><dd data-generated>${escapeHtml(formatStamp(state.generatedAt))}</dd>
    </dl>
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

${renderOrder(state)}

${renderExcluded(state)}

  <section class="card">
    <h2>装完怎么验（想手工核就走这两条，都不用跑 <code>--help</code>）</h2>
    <p class="sec">① 插件类：<code>dsh --profile ${escapeHtml(state.profile || 'web')} --dump-config</code>，在输出里搜 <code># == &lt;包名&gt;</code> —— 恰好 1 次才算真挂上。</p>
    <p class="sec">② 命令行类：看 <code>&lt;全局前缀&gt;/node_modules/&lt;包&gt;/package.json</code> 在不在（只查文件，不执行命令）。</p>
    <p class="sec">③ 想省事的整批自检：<code>node &lt;dsh-butler-core 仓根&gt;/selfcheck-replica.mjs --manifest suite-manifest.json</code>。</p>
    <p class="sec">④ 插件装完要<b>重启 DSH</b> 才会出现在侧边栏 —— 见上面进度区那块绿框。</p>
  </section>

  <footer>
    <b>安全边界（写死的，不是可选项）</b><br>
    · 只绑 <code>127.0.0.1</code>：同一局域网的别的机器连不上，也没有 <code>0.0.0.0</code> 开关。<br>
    · 写入口只有四条（<code>POST /install/preview</code> · <code>/install/start</code> · <code>/install/cancel</code> · <code>/install/rollback</code>），
      每条都要<b>安装令牌</b>（页面从内嵌 meta 读，绝不拼进 URL）<b>+ 同源校验</b>（<code>Origin</code> 逐字等于本服务的实际地址）。
      别的站点发来的请求进不来；除这四条之外的写方法一律 405。<br>
    · 🔴 <b>这条要如实说</b>：它防不住<b>本机、同一个 Windows 用户下的其他程序</b> —— 那些程序读得到这个页面、也调得到这些接口。
      它是一个"给本机同一个人用的安装器"，不是多用户隔离的服务。<br>
    · 装什么、成没成，判据一律在服务端现跑；这个页面只是个按按钮的壳。<br>
    · 当前地址 <code>${escapeHtml(url || '—')}</code>
  </footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
