#!/usr/bin/env node
/**
 * tools/cdp.mjs — 本工作区唯一的 CDP 客户端。零依赖，要求 Node >= 22（全局 WebSocket）。
 *
 * 设计要点（都是踩过的坑，别改回去）：
 *  1. 页签按名字认领：var/tabs/<名字>.json。不用环境变量——DSH 里每条命令是新进程，
 *     $env:CDP_TARGET 跨命令不保留。
 *  2. 多页签且没指定归属时**拒绝猜测**并列出候选，绝不静默落到别人的页签上。
 *  3. 就绪判断用轮询 document.readyState，不用 Page.loadEventFired（有竞态，会永久卡住）。
 *  4. 点击用 Input.dispatchMouseEvent 打真实鼠标事件（el.click() 对单页应用常常无效）。
 *  5. 填值走原型上的原生 value setter 再派发 input/change（直接赋值 React/Vue 不认）。
 *  6. 没有 Browser.close 这个命令，故意的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = (process.env.CDP_BASE || 'http://127.0.0.1:9222').replace(/\/+$/, '');
const TABS_DIR = path.join(ROOT, 'var', 'tabs');
const ARTIFACTS = path.join(ROOT, 'var', 'artifacts');

const USAGE = `用法：
  node tools/cdp.mjs <命令> [参数...] [--tab 名字 | --target ID] [--frame 片段] [--timeout 毫秒]

命令：
  tabs                      列出页签，并标注谁认领了哪个
  newtab <名字> [url]       新建页签、认领给它、打印 targetId
  close                     关闭页签（配合 --tab 释放认领）
  whoami                    当前页签的 title / url / readyState
  nav <url>                 导航并等到就绪
  text                      正文 innerText
  html                      整页 outerHTML
  eval <表达式>             在页面求值（或用 --file 从文件读）
  click <css>              真实鼠标点击（不是 el.click）；也可 click --text <按钮文字>
  fill <css> <文本>         填值并触发 input/change
  wait <css>                等元素出现；用 --text <片段> 则等文字出现
  frames                    列出所有 iframe（frameId + url）
  shot [文件]               截图，默认写 var/artifacts/

例子：
  node tools/cdp.mjs newtab --tab alice https://example.com
  node tools/cdp.mjs --tab alice text
  node tools/cdp.mjs --tab alice frames
  node tools/cdp.mjs --tab alice --frame /lesson/ text
  node tools/cdp.mjs --tab alice shot var/artifacts/lesson.png
`;

// ── 参数 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !(next.startsWith('--') && next.length > 2)) { opts[key] = next; i++; }
      else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

// ── HTTP（/json/*）───────────────────────────────────────────────────────
async function api(p, method = 'GET') {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(BASE + p, { method, signal: ac.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${method} ${p}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`CDP ${BASE} 8 秒无响应。端口可能被陈旧进程占着 → powershell -NoProfile -File tools\doctor.ps1`);
    if (/fetch failed|ECONNREFUSED|ECONNRESET/i.test(String(e.message) + String(e.cause?.code ?? '')))
      throw new Error(`连不上 ${BASE}——浏览器没在跑。先 powershell -NoProfile -File tools\start-edge.ps1`);
    throw e;
  } finally { clearTimeout(timer); }
}

async function listPages() {
  const list = await api('/json/list');
  return (Array.isArray(list) ? list : [])
    .filter((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
}

// ── 页签认领记录 ─────────────────────────────────────────────────────────
function tabFile(name) { return path.join(TABS_DIR, `${name}.json`); }

function readTabRecord(name) {
  const f = tabFile(name);
  if (!fs.existsSync(f)) throw new Error(`没有名为 "${name}" 的认领记录。先：node tools/cdp.mjs newtab --tab ${name} <url>`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { throw new Error(`认领记录损坏：${f}（删掉它再 newtab 一次即可）`); }
}

function writeTabRecord(name, rec) {
  fs.mkdirSync(TABS_DIR, { recursive: true });
  fs.writeFileSync(tabFile(name), JSON.stringify(rec, null, 2) + '\n', 'utf8');
}

function dropTabRecord(name) { try { fs.unlinkSync(tabFile(name)); } catch {} }

function allClaims() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(TABS_DIR).filter((f) => f.endsWith('.json')); } catch { return map; }
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(TABS_DIR, f), 'utf8'));
      if (rec && rec.id) map.set(rec.id, rec.name || f.replace(/\.json$/, ''));
    } catch {}
  }
  return map;
}

// ── WebSocket 会话 ───────────────────────────────────────────────────────
class Session {
  constructor(ws, timeoutMs) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = []; this.timeoutMs = timeoutMs;
  }
  static async open(wsUrl, timeoutMs) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('WebSocket 打开超时（10s）')), 10000);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error(`WebSocket 打不开：${wsUrl}`)); };
    });
    const s = new Session(ws, timeoutMs);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && s.pending.has(msg.id)) { s.pending.get(msg.id)(msg); s.pending.delete(msg.id); return; }
      if (!msg.method) return;
      const i = s.waiters.findIndex((w) => w.method === msg.method);
      if (i >= 0) { const w = s.waiters.splice(i, 1)[0]; w.resolve(msg.params); }
    };
    return s;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} 超时（${this.timeoutMs}ms）`)); }, this.timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// ── 求值 ─────────────────────────────────────────────────────────────────
async function evaluate(s, expression, ctxId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (ctxId) params.contextId = ctxId;
  const r = await s.send('Runtime.evaluate', params);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`页面内异常：${d.exception?.description || d.text || '未知'}`);
  }
  return r.result ? r.result.value : undefined;
}

// ── iframe ───────────────────────────────────────────────────────────────
function flattenFrames(node, out = []) {
  if (!node || !node.frame) return out;
  out.push({ id: node.frame.id, url: node.frame.url || node.frame.urlFragment || '', name: node.frame.name || '' });
  for (const c of node.childFrames || []) flattenFrames(c, out);
  return out;
}

async function listFrames(s) {
  const tree = await s.send('Page.getFrameTree');
  return flattenFrames(tree.frameTree);
}

async function frameContext(s, needle) {
  const frames = await listFrames(s);
  const matches = frames.filter((f) => f.url.includes(needle) || f.name.includes(needle));
  if (matches.length === 0) {
    throw new Error(`没有匹配 "${needle}" 的 frame。现有：\n` + frames.map((f) => `  ${f.id}  ${f.url.slice(0, 120)}`).join('\n'));
  }
  if (matches.length > 1) {
    throw new Error(`"${needle}" 匹配到 ${matches.length} 个 frame，请给更长的片段：\n` + matches.map((f) => `  ${f.id}  ${f.url.slice(0, 120)}`).join('\n'));
  }
  const { executionContextId } = await s.send('Page.createIsolatedWorld', { frameId: matches[0].id, worldName: '__dsh' });
  return { ctxId: executionContextId, frame: matches[0], count: frames.length };
}

// ── 选页签 ───────────────────────────────────────────────────────────────
async function resolvePage(opts) {
  const pages = await listPages();

  if (opts.target) {
    const hit = pages.find((p) => p.id === opts.target);
    if (!hit) throw new Error(`找不到 targetId ${opts.target}。现有：\n${pages.map((p) => `  ${p.id}  ${p.title}  ${p.url}`).join('\n')}`);
    return hit;
  }

  if (opts.tab) {
    const rec = readTabRecord(opts.tab);
    const hit = pages.find((p) => p.id === rec.id);
    if (!hit) throw new Error(`页签 "${opts.tab}" 已经不在了（${rec.id}）。重新认领：node tools/cdp.mjs newtab --tab ${opts.tab} ${rec.url || '<url>'}`);
    return hit;
  }

  if (pages.length === 0) throw new Error('没有任何页签。先：node tools/cdp.mjs newtab --tab <名字> <url>');
  if (pages.length === 1) return pages[0];

  throw new Error(
    `有 ${pages.length} 个页签，且没给 --tab / --target，拒绝猜测。` +
    `\n${pages.map((p) => `  ${p.id}  ${p.title}  ${p.url}`).join('\n')}` +
    `\n\n指定归属：加 --tab <你的名字>，或 --target <id>。`
  );
}

async function withPage(opts, fn) {
  const page = await resolvePage(opts);
  const s = await Session.open(page.webSocketDebuggerUrl, num(opts.timeout, 30000));
  try {
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    return await fn(s, page);
  } finally { s.close(); }
}

// ── 就绪 ─────────────────────────────────────────────────────────────────
async function waitReady(s, limitMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    try {
      const st = await evaluate(s, 'document.readyState');
      if (st === 'complete') return Date.now() - t0;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return -1;
}

async function waitFrames(s) {
  // 后台页签里 requestAnimationFrame 不跑，等帧必须自带上限，否则会一直卡到 send 的 30s 超时。
  try {
    await evaluate(s, `new Promise((r) => {
      if (document.visibilityState === 'hidden') return r('hidden');
      let n = 0;
      const tick = () => { if (++n >= 2) return r('ok'); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      setTimeout(() => r('timeout'), 1500);
    })`);
  } catch {}
}

// ── 输出 ─────────────────────────────────────────────────────────────────
const out = (v) => {
  if (typeof v === 'string') console.log(v);
  else console.log(JSON.stringify(v, null, 2));
};

function pngSize(buf) {
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── 主流程 ───────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = opts._;
const timeout = num(opts.timeout, 30000);

try {
  if (!cmd) { console.error(USAGE); process.exit(2); }

  if (cmd === 'tabs') {
    const pages = await listPages();
    const claims = allClaims();
    out(pages.map((p) => ({ id: p.id, owner: claims.get(p.id) || null, title: p.title, url: p.url })));
  } else if (cmd === 'newtab') {
    const name = (typeof opts.tab === 'string' && opts.tab) || rest[0];
    if (!name) throw new Error('newtab 需要名字：node tools/cdp.mjs newtab --tab <名字> <url>');
    let url = 'about:blank';
    if (rest[0] === name) { if (rest[1]) url = rest[1]; }
    else if (rest[0]) url = rest[0];

    const pages = await listPages();
    const old = fs.existsSync(tabFile(name)) ? JSON.parse(fs.readFileSync(tabFile(name), 'utf8')) : null;
    if (old && pages.some((p) => p.id === old.id))
      throw new Error(`名字 "${name}" 已被占用且页签还活着（${old.id}）。换个名字，或先 node tools/cdp.mjs close --tab ${name}`);

    // 先用 about:blank 建页签，再用 Page.navigate 导航：绕开 /json/new 的 URL 编码坑（? 和 # 会被编掉）。
    const t = await api('/json/new?about:blank', 'PUT');
    const s = await Session.open(t.webSocketDebuggerUrl, timeout);
    let readyMs = 0;
    let info = null;
    try {
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      if (url && url !== 'about:blank') {
        await s.send('Page.navigate', { url });
        readyMs = await waitReady(s, timeout);
      }
      info = await evaluate(s, '({title: document.title, url: location.href})').catch(() => null);
    } finally { s.close(); }

    writeTabRecord(name, { name, id: t.id, url, createdAt: new Date().toISOString(), lastUsedAt: null });
    out({ claimed: name, targetId: t.id, requested: url, readyMs: readyMs < 0 ? 'TIMEOUT' : readyMs, page: info });
  } else if (cmd === 'close') {
    if (opts.tab) {
      const rec = readTabRecord(opts.tab);
      const r = await api('/json/close/' + rec.id).catch((e) => 'ERR ' + e.message);
      dropTabRecord(opts.tab);
      out({ closed: rec.id, name: opts.tab, result: r });
    } else if (opts.target) {
      const r = await api('/json/close/' + opts.target);
      out({ closed: opts.target, result: r, note: '按 id 关闭，没有释放任何认领记录' });
    } else {
      throw new Error('close 必须指定 --tab <名字>（推荐）或 --target <id>。别关不认识的页签。');
    }
  } else if (cmd === 'whoami') {
    await withPage(opts, async (s, page) => out({
      targetId: page.id,
      ...(await evaluate(s, '({title: document.title, url: location.href, readyState: document.readyState})')),
    }));
  } else if (cmd === 'nav') {
    const url = rest[0];
    if (!url) throw new Error('nav 需要 url');
    await withPage(opts, async (s) => {
      const r = await s.send('Page.navigate', { url });
      const ms = await waitReady(s, timeout);
      const info = await evaluate(s, '({title: document.title, url: location.href})').catch(() => ({}));
      out({ ...info, readyMs: ms < 0 ? 'TIMEOUT' : ms, frameId: r?.frameId });
    });
  } else if (cmd === 'text') {
    await withPage(opts, async (s) => {
      let ctxId;
      if (opts.frame) { const f = await frameContext(s, String(opts.frame)); ctxId = f.ctxId; }
      const v = await evaluate(s, 'document.body ? document.body.innerText : ""', ctxId);
      out(String(v ?? '').replace(/\n{3,}/g, '\n\n').trim());
    });
  } else if (cmd === 'html') {
    await withPage(opts, async (s) => {
      let ctxId;
      if (opts.frame) { const f = await frameContext(s, String(opts.frame)); ctxId = f.ctxId; }
      out(await evaluate(s, 'document.documentElement.outerHTML', ctxId));
    });
  } else if (cmd === 'eval') {
    let expr = rest.join(' ');
    if (opts.file) expr = fs.readFileSync(String(opts.file), 'utf8');
    if (!expr) throw new Error('eval 需要表达式，或用 --file <路径>');
    await withPage(opts, async (s) => {
      let ctxId;
      if (opts.frame) { const f = await frameContext(s, String(opts.frame)); ctxId = f.ctxId; }
      out(await evaluate(s, expr, ctxId));
    });
  } else if (cmd === 'frames') {
    await withPage(opts, async (s) => out(await listFrames(s)));
  } else if (cmd === 'wait') {
    const sel = rest[0];
    if (!sel && !opts.text) throw new Error('wait 需要 css 选择器，或 --text <片段>');
    const limit = num(opts.timeout, num(rest[1], 15000));
    await withPage(opts, async (s) => {
      const t0 = Date.now();
      while (Date.now() - t0 < limit) {
        const hit = opts.text
          ? await evaluate(s, `(document.body ? document.body.innerText : '').includes(${JSON.stringify(String(opts.text))})`).catch(() => false)
          : await evaluate(s, `!!document.querySelector(${JSON.stringify(sel)})`).catch(() => false);
        if (hit) { out({ found: true, ms: Date.now() - t0, of: opts.text ? `text:${opts.text}` : sel }); return; }
        await new Promise((r) => setTimeout(r, 200));
      }
      out({ found: false, ms: Date.now() - t0, of: opts.text ? `text:${opts.text}` : sel });
      process.exitCode = 3;
    });
  } else if (cmd === 'click') {
    const sel = rest[0];
    if (!sel && !opts.text) throw new Error('click 需要 css 选择器，或 --text <按钮文字>');
    const label = sel || `按钮 "${opts.text}"`;
    // 按文字找按钮：先找真正可点的元素，再退到只含文字的叶子节点——避免误点包住整页的大容器。
    const finder = sel
      ? `document.querySelector(${JSON.stringify(sel)})`
      : `(() => {
          const want = ${JSON.stringify(String(opts.text))};
          const norm = (e) => (e.innerText || e.value || '').trim();
          const pool = [...document.querySelectorAll('button,input[type=submit],input[type=button],a,[role=button]')];
          return pool.find((e) => norm(e) === want)
            || pool.find((e) => norm(e).includes(want))
            || [...document.querySelectorAll('span,div,li,label,td')].filter((e) => e.children.length === 0).find((e) => norm(e) === want)
            || null;
        })()`;
    await withPage(opts, async (s) => {
      const box = await evaluate(s, `(() => {
        const el = ${finder};
        if (!el) return { ok: false, why: 'not found' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) return { ok: false, why: 'zero size (display:none?)' };
        return { ok: true, x: b.left + b.width / 2, y: b.top + b.height / 2, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 60) };
      })()`);
      if (!box || !box.ok) throw new Error(`点不到 ${label}：${(box && box.why) || '页面没有返回元素信息'}`);
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      out({ clicked: label, at: { x: Math.round(box.x), y: Math.round(box.y) }, tag: box.tag, text: box.text });
    });
  } else if (cmd === 'fill') {
    const sel = rest[0];
    const text = rest.slice(1).join(' ');
    if (!sel) throw new Error('fill 需要 css 选择器');
    await withPage(opts, async (s) => {
      const r = await evaluate(s, `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { ok: false, why: 'not found' };
        el.focus();
        const v = ${JSON.stringify(text)};
        if (el.isContentEditable) {
          el.textContent = v;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (!desc || !desc.set) return { ok: false, why: 'no native value setter on ' + el.tagName };
          desc.set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, tag: el.tagName, value: String(el.value ?? el.textContent).slice(0, 80) };
      })()`);
      if (!r.ok) throw new Error(`填不了 ${sel}：${r.why}`);
      out({ filled: sel, ...r });
    });
  } else if (cmd === 'shot') {
    const target = rest[0] || path.join(ARTIFACTS, `shot-${Date.now()}.png`);
    const abs = path.isAbsolute(target) ? target : path.join(ROOT, target);
    await withPage(opts, async (s) => {
      await waitFrames(s);
      const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
      const buf = Buffer.from(r.data, 'base64');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      out({ saved: path.relative(ROOT, abs), bytes: buf.length, ...(pngSize(buf) || {}) });
    });
  } else {
    console.error(`未知命令：${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error('ERROR: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
