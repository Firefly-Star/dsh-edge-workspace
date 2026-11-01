#!/usr/bin/env node
/**
 * tools/cdp.mjs — 本工作区唯一的 CDP 客户端。零依赖，要求 Node >= 22（全局 WebSocket）。
 *
 * 设计要点（都是踩过的坑，别改回去）：
 *  1. 页签按名字认领：var/tabs/<targetId>.json。一个页签可以被多个名字同时认领
 *     （claims 就是引用计数），关闭时只减自己的引用，计数清零才真的关页签。
 *  2. 多页签且没指定归属时**拒绝猜测**并列出候选，绝不静默落到别人的页签上。
 *  3. 就绪判断用轮询 document.readyState，不用 Page.loadEventFired（有竞态，会永久卡住）。
 *  4. 点击用 Input.dispatchMouseEvent 打真实鼠标事件（el.click() 对单页应用常常无效）。
 *  5. 填值走原型上的原生 value setter 再派发 input/change（直接赋值 React/Vue 不认）。
 *  6. 没有 Browser.close 这个命令，故意的。
 *  7. **每次操作都由客户端记账**：不是让 agent 自觉写日志，是命令本身在发出去之前/之后
 *     往记录里写一条「谁、什么时候、做了什么、成没成」。共享页签的 agent 看 log 就知道
 *     页面为什么变样了。读操作不落账（否则全是噪声），改页面的操作一律落账。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = (process.env.CDP_BASE || 'http://127.0.0.1:9222').replace(/\/+$/, '');
const TABS_DIR = path.join(ROOT, 'var', 'tabs');
const ARTIFACTS = path.join(ROOT, 'var', 'artifacts');
const LOG_CAP = 50;          // 每个页签最多留多少条流水
const LOCK_TIMEOUT = 3000;   // 等记录锁的上限

// 下游把管道关掉（例如 | Select-Object -First 1）时安静退出，别抛未捕获异常再去抢锁。
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });

const USAGE = `用法：
  node tools/cdp.mjs <命令> [参数...] [--tab 名字 | --target ID] [--frame 片段] [--timeout 毫秒]

认领（共享页签）：
  newtab <名字> [url]       新建页签并认领，打印 targetId
  claim --tab <名字> --target <id>
                            认领一个**已经存在**的页签（可以多人认领同一个）
  close --tab <名字>        释放自己那份引用；还有别人认领就只是减计数，
                            计数清零才真的关闭页签
  tabs                      列出页签、认领者、以及失效的认领记录
  log --tab <名字>          看这个页签的操作流水（谁·何时·做了什么）

页面操作：
  whoami                    当前页签的 title / url / readyState / 认领者
  nav <url>                 导航并等到就绪
  text                      正文 innerText
  html                      整页 outerHTML
  eval <表达式>             在页面求值（或用 --file 从文件读）
  click <css>               真实鼠标点击（不是 el.click）；也可 click --text <按钮文字>
  fill <css> <文本>         填值并触发 input/change
  wait <css>                等元素出现；用 --text <片段> 则等文字出现
  frames                    列出所有 iframe（frameId + url）
  shot [文件]               截图，默认写 var/artifacts/

例子：
  node tools/cdp.mjs newtab --tab alice https://example.com
  node tools/cdp.mjs claim --tab bob --target 68C42EC2ABB058383D37C29BF2942EB8
  node tools/cdp.mjs --tab bob text
  node tools/cdp.mjs --tab bob log
  node tools/cdp.mjs close --tab bob        # bob 退出，alice 还留着，页签不关

记账规则：nav / click / fill / eval 会改页面，一律写进操作流水（无论有没有认领）；
text / html / whoami / frames / shot 是只读，不写。` + '\n';

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
const trim = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const nowIso = () => new Date().toISOString();

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
    if (e.name === 'AbortError') throw new Error(`CDP ${BASE} 8 秒无响应。端口可能被陈旧进程占着 → powershell -NoProfile -ExecutionPolicy Bypass -File tools\\doctor.ps1`);
    if (/fetch failed|ECONNREFUSED|ECONNRESET/i.test(String(e.message) + String(e.cause?.code ?? '')))
      throw new Error(`连不上 ${BASE}——浏览器没在跑。先 powershell -NoProfile -ExecutionPolicy Bypass -File tools\\start-edge.ps1`);
    throw e;
  } finally { clearTimeout(timer); }
}

async function listPages() {
  const list = await api('/json/list');
  return (Array.isArray(list) ? list : [])
    .filter((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
}

// ── 记录层（认领 + 流水）────────────────────────────────────────────────
// 一条记录 = 一个页签：{ id, url, title, createdAt, updatedAt, claims, log }
// claims = { 名字: { since, lastUsed } }，键数就是引用计数。

function ensureTabsDir() { fs.mkdirSync(TABS_DIR, { recursive: true }); }
function recFile(id) { return path.join(TABS_DIR, `${id}.json`); }

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  // 旧格式（<名字>.json：{name, id, url, createdAt, lastUsedAt}）就地升级成新格式
  if (!raw.claims && raw.name) {
    const at = raw.createdAt || nowIso();
    return {
      id: raw.id, url: raw.url || '', title: '',
      createdAt: at, updatedAt: at,
      claims: { [raw.name]: { since: at, lastUsed: raw.lastUsedAt || null } },
      log: [],
      origin: 'created',
    };
  }
  const rec = {
    id: raw.id,
    url: raw.url || '',
    title: raw.title || '',
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || raw.createdAt || nowIso(),
    claims: (raw.claims && typeof raw.claims === 'object') ? raw.claims : {},
    log: Array.isArray(raw.log) ? raw.log : [],
    // created = 本工作区 newtab 出来的；adopted = claim 认领来的别人的页签。
    // 只有 created 的页签在引用计数清零时才真的关闭。
    origin: raw.origin === 'created' ? 'created' : 'adopted',
  };
  return rec;
}

function readRecord(id) {
  const f = recFile(id);
  if (!fs.existsSync(f)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { throw new Error(`认领记录损坏：${f}（删掉它，重新 newtab 或 claim 一次即可）`); }
  return normalizeRecord(raw);
}

// 读出目录下所有记录；顺手把旧格式的文件名迁移成 <id>.json
function loadAll() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(TABS_DIR); } catch { return map; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(TABS_DIR, f);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    const rec = normalizeRecord(raw);
    if (!rec) continue;
    map.set(rec.id, rec);
    if (f !== `${rec.id}.json`) { try { writeJsonAtomic(recFile(rec.id), rec); fs.unlinkSync(full); } catch {} }
  }
  return map;
}

function writeJsonAtomic(file, obj) {
  ensureTabsDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);   // 同目录 rename 是原子替换，读者要么看到旧的要么看到新的
}

// 记录锁：多个 agent 同时写同一个页签的记录时串行化，避免互相覆盖。
// 用 'wx' 打开（已存在就失败）当原子锁。锁文件里写持有者 pid：持有者进程已经死了
// 就立刻抢过来（命令被 kill、管道被下游截断都会留下锁，不能因此卡住 30 秒）。
function lockIsStale(lock) {
  let owner = 0;
  try { owner = parseInt(fs.readFileSync(lock, 'utf8'), 10) || 0; } catch { return true; }
  if (!owner) return true;
  if (owner === process.pid) return false;
  try { process.kill(owner, 0); return false; }        // 还活着
  catch (e) { if (e.code === 'ESRCH') return true; }   // 进程没了 -> 僵尸锁
  try { return Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch { return true; }
}

function acquireLock(id) {
  ensureTabsDir();
  const lock = path.join(TABS_DIR, `${id}.lock`);
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(lock)) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() - t0 > LOCK_TIMEOUT) throw new Error(`页签记录被别的进程锁着（${lock}）。稍后重试。`);
      const until = Date.now() + 15;
      while (Date.now() < until) { /* 短自旋，几十毫秒级 */ }
    }
  }
}

function releaseLock(lock) { try { fs.unlinkSync(lock); } catch {} }

// 读-改-写一条记录。mutator 收到记录（可能为 null），返回新记录；
// 返回 null 表示删除这条记录（页签已经没了）。
function updateRecord(id, mutator) {
  const lock = acquireLock(id);
  try {
    let rec = readRecord(id);
    const res = mutator(rec);
    if (res === null) { try { fs.unlinkSync(recFile(id)); } catch {} return null; }
    rec = res;
    rec.id = id;
    rec.updatedAt = nowIso();
    if (!Array.isArray(rec.log)) rec.log = [];
    if (rec.log.length > LOG_CAP) rec.log = rec.log.slice(-LOG_CAP);
    writeJsonAtomic(recFile(id), rec);
    return rec;
  } finally { releaseLock(lock); }
}

function ownersOf(rec) { return rec && rec.claims ? Object.keys(rec.claims) : []; }

// 记账。策略：改页面的操作一定要留痕（记录不存在就建一条匿名记录），
// 只读操作只在已有记录时留痕，避免把 var/tabs 刷成噪声。
function note(id, who, cmd, detail, ok, errText) {
  if (!id) return;
  try {
    const exists = fs.existsSync(recFile(id));
    if (!exists) {
      // 没人认领的只读操作：不建记录
      if (!MUTATING.has(cmd)) return;
      updateRecord(id, () => ({ id, url: '', title: '', createdAt: nowIso(), updatedAt: nowIso(), claims: {}, log: [] }));
    }
    updateRecord(id, (rec) => {
      if (!rec) return rec;
      rec.log.push({ at: nowIso(), who, cmd, detail: trim(detail), ok: ok !== false, ...(errText ? { error: trim(errText, 160) } : {}) });
      return rec;
    });
  } catch (e) {
    // 记账失败不能把命令本身带崩，但必须让人看见
    console.error(`WARN: 操作流水写入失败（${id}）：${e.message}`);
  }
}

// 按名字找它认领的那个活页签；顺手清掉指向已消失页签的认领。
async function claimByName(name) {
  const recs = [...loadAll().values()].filter((r) => r.claims && r.claims[name]);
  if (recs.length === 0) return null;
  const pages = await listPages();
  const alive = [];
  for (const r of recs) {
    if (pages.some((p) => p.id === r.id)) { alive.push(r); continue; }
    // 页签没了：收回这个名字的认领
    updateRecord(r.id, (rec) => {
      if (!rec) return rec;
      delete rec.claims[name];
      return ownersOf(rec).length === 0 && rec.log.length === 0 ? null : rec;
    });
  }
  if (alive.length === 0) return null;
  if (alive.length > 1) {
    throw new Error(
      `名字 "${name}" 同时认领着 ${alive.length} 个页签，拒绝猜测：\n` +
      alive.map((r) => `  ${r.id}  ${r.title || ''}  ${r.url}`).join('\n') +
      `\n先用 close --tab ${name} 释放其中一个（或改用 --target <id>）。`
    );
  }
  return alive[0];
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
    const rec = await claimByName(opts.tab);
    if (!rec) throw new Error(`名字 "${opts.tab}" 没有认领任何活着的页签。新建：newtab --tab ${opts.tab} <url>；认领已有的：claim --tab ${opts.tab} --target <id>`);
    const hit = pages.find((p) => p.id === rec.id);
    if (!hit) throw new Error(`页签 "${opts.tab}" 已经不在了（${rec.id}）。重新认领：claim --tab ${opts.tab} --target <id>`);
    return hit;
  }

  if (pages.length === 0) throw new Error('没有任何页签。先：newtab --tab <名字> <url>');
  if (pages.length === 1) return pages[0];

  throw new Error(
    `有 ${pages.length} 个页签，且没给 --tab / --target，拒绝猜测。` +
    `\n${pages.map((p) => `  ${p.id}  ${p.title}  ${p.url}`).join('\n')}` +
    `\n\n指定归属：加 --tab <你的名字>（先认领），或 --target <id>。`
  );
}

// 所有页面命令都走这里：解析页签 → 执行 → 记账（成功/失败都记）。
async function withPage(opts, action, fn) {
  const page = await resolvePage(opts);
  const who = opts.tab && typeof opts.tab === 'string' ? opts.tab : '-';
  if (!opts.tab && MUTATING.has(action.cmd)) {
    const rec = readRecord(page.id);
    const others = ownersOf(rec);
    if (others.length) console.error(`WARN: 页签 ${page.id} 被 ${others.join(', ')} 认领着，你没有 --tab，这次改动会记成 who=-`);
  }
  const s = await Session.open(page.webSocketDebuggerUrl, num(opts.timeout, 30000));
  try {
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    const result = await fn(s, page);
    note(page.id, who, action.cmd, action.detail, true);
    // 导航后把记录里的 url/title 跟上，否则 tabs / log 会一直显示旧地址
    if (action.cmd === 'nav' && result && result.url) {
      try {
        updateRecord(page.id, (rec) => {
          if (!rec) return rec;
          rec.url = result.url;
          if (result.title) rec.title = result.title;
          return rec;
        });
      } catch {}
    }
    return result;
  } catch (e) {
    note(page.id, who, action.cmd, action.detail, false, e.message);
    throw e;
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

// 会改页面的命令：一律留痕（没有认领就建一条匿名记录）
const MUTATING = new Set(['nav', 'click', 'fill', 'eval', 'newtab', 'claim', 'close']);

// ── 主流程 ───────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = opts._;
const timeout = num(opts.timeout, 30000);

try {
  if (!cmd) { console.error(USAGE); process.exit(2); }

  if (cmd === 'tabs') {
    const pages = await listPages();
    const recs = loadAll();
    const live = new Set(pages.map((p) => p.id));
    const rows = pages.map((p) => {
      const rec = recs.get(p.id);
      return { id: p.id, owners: ownersOf(rec), lastBy: rec?.log?.length ? rec.log[rec.log.length - 1].who : null, title: p.title, url: p.url };
    });
    // 认领记录还在、页签已经消失的，单独列出来，别假装没事
    for (const rec of recs.values()) {
      if (!live.has(rec.id)) rows.push({ id: rec.id, owners: ownersOf(rec), stale: true, title: rec.title || '', url: rec.url || '' });
    }
    out(rows);

  } else if (cmd === 'newtab') {
    const name = (typeof opts.tab === 'string' && opts.tab) || rest[0];
    if (!name) throw new Error('newtab 需要名字：node tools/cdp.mjs newtab --tab <名字> <url>');
    let url = 'about:blank';
    if (rest[0] === name) { if (rest[1]) url = rest[1]; }
    else if (rest[0]) url = rest[0];

    const used = await claimByName(name);
    if (used) throw new Error(`名字 "${name}" 已经认领着 "${used.title || used.url}"（${used.id}）。换个名字，或先 close --tab ${name}`);

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

    const at = nowIso();
    updateRecord(t.id, () => ({
      id: t.id,
      url: (info && info.url) || url,
      title: (info && info.title) || '',
      createdAt: at,
      updatedAt: at,
      claims: { [name]: { since: at, lastUsed: at } },
      log: [{ at, who: name, cmd: 'newtab', detail: trim(url), ok: true }],
      origin: 'created',
    }));
    out({ claimed: name, targetId: t.id, requested: url, readyMs: readyMs < 0 ? 'TIMEOUT' : readyMs, page: info });

  } else if (cmd === 'claim') {
    const name = typeof opts.tab === 'string' ? opts.tab : rest[0];
    const targetId = typeof opts.target === 'string' ? opts.target : rest[1];
    if (!name || !targetId) throw new Error('claim 需要名字和目标：node tools/cdp.mjs claim --tab <名字> --target <页签id>');
    const pages = await listPages();
    const page = pages.find((p) => p.id === targetId);
    if (!page) throw new Error(`找不到 targetId ${targetId}。现有：\n${pages.map((p) => `  ${p.id}  ${p.title}  ${p.url}`).join('\n')}`);
    const used = await claimByName(name);
    if (used && used.id !== targetId) throw new Error(`名字 "${name}" 已经认领着另一个页签（${used.id}）。先 close --tab ${name} 释放。`);

    let owners = [];
    const rec = updateRecord(targetId, (r) => {
      const at = nowIso();
      const base = r || { id: targetId, url: '', title: '', createdAt: at, updatedAt: at, claims: {}, log: [], origin: 'adopted' };
      base.url = page.url || base.url;
      base.title = page.title || base.title;
      if (!base.claims) base.claims = {};
      if (!base.claims[name]) base.claims[name] = { since: at, lastUsed: at };
      base.log.push({ at, who: name, cmd: 'claim', detail: `认领已有页签（当前 ${ownersOf(base).length} 个引用）`, ok: true });
      return base;
    });
    owners = ownersOf(rec);
    out({
      claimed: name,
      targetId,
      origin: rec.origin,
      refCount: owners.length,
      owners,
      note: owners.length > 1
        ? '这个页签有多个认领者，close 只是释放你自己那份'
        : (rec.origin === 'created'
            ? '你是唯一认领者，close 会真的关掉页签'
            : '这是认领来的页签（不是本工作区新建的），close 只释放引用，不会关掉页面'),
    });

  } else if (cmd === 'close') {
    if (opts.tab) {
      const rec = await claimByName(opts.tab);
      if (!rec) throw new Error(`名字 "${opts.tab}" 没有认领任何活着的页签（失效记录已自动清理）。`);
      let remaining = [];
      updateRecord(rec.id, (r) => {
        if (!r) return r;
        delete r.claims[opts.tab];
        remaining = ownersOf(r);
        r.log.push({ at: nowIso(), who: opts.tab, cmd: 'close', detail: remaining.length ? `释放引用，还剩 ${remaining.length} 个（页签不关）` : '最后一个引用，关闭页签', ok: true });
        return r;
      });
      if (remaining.length > 0) {
        out({ released: opts.tab, targetId: rec.id, refCount: remaining.length, stillClaimedBy: remaining, note: '页签没有关闭，还有别人在认领' });
      } else if ((rec.origin || 'adopted') === 'created') {
        const r = await api('/json/close/' + rec.id).catch((e) => 'ERR ' + e.message);
        updateRecord(rec.id, () => null);
        out({ closed: rec.id, name: opts.tab, result: r, note: '引用计数清零，页签已关闭' });
      } else {
        // 认领来的页签：只释放引用，页面留着（这不是我们开出来的，不能替别人关）
        out({ released: opts.tab, targetId: rec.id, refCount: 0, note: '这是认领来的页签，只释放引用，不关闭页面；记录保留供后续查看' });
      }
    } else if (opts.target) {
      const rec = readRecord(opts.target);
      const owners = ownersOf(rec);
      if (owners.length) throw new Error(`页签 ${opts.target} 还被 ${owners.join(', ')} 认领着，不能硬关。先让它们 close --tab。`);
      const r = await api('/json/close/' + opts.target);
      if (rec) updateRecord(opts.target, () => null);
      out({ closed: opts.target, result: r, note: '按 id 关闭，没有释放任何认领记录' });
    } else {
      throw new Error('close 必须指定 --tab <名字>（推荐）或 --target <id>。别关不认识的页签。');
    }

  } else if (cmd === 'log') {
    const rec = opts.tab ? await claimByName(opts.tab) : (opts.target ? readRecord(opts.target) : null);
    if (!rec) throw new Error('log 需要 --tab <名字> 或 --target <页签id>');
    const limit = num(opts.limit, 10);
    out({
      targetId: rec.id,
      url: rec.url,
      title: rec.title,
      owners: ownersOf(rec).map((n) => ({ name: n, ...rec.claims[n] })),
      entries: rec.log.slice(-limit),
      totalEntries: rec.log.length,
    });

  } else if (cmd === 'whoami') {
    await withPage(opts, { cmd: 'whoami', detail: '' }, async (s, page) => {
      const info = await evaluate(s, '({title: document.title, url: location.href, readyState: document.readyState})');
      const rec = readRecord(page.id);
      out({ targetId: page.id, ...info, owners: ownersOf(rec), shared: ownersOf(rec).length > 1 });
    });
  } else if (cmd === 'nav') {
    const url = rest[0];
    if (!url) throw new Error('nav 需要 url');
    await withPage(opts, { cmd: 'nav', detail: trim(url) }, async (s) => {
      const r = await s.send('Page.navigate', { url });
      const ms = await waitReady(s, timeout);
      const info = await evaluate(s, '({title: document.title, url: location.href})').catch(() => ({}));
      const res = { ...info, readyMs: ms < 0 ? 'TIMEOUT' : ms, frameId: r?.frameId };
      out(res);
      return res;
    });
  } else if (cmd === 'text') {
    await withPage(opts, { cmd: 'text', detail: opts.frame ? `frame:${opts.frame}` : '' }, async (s) => {
      let ctxId;
      if (opts.frame) { const f = await frameContext(s, String(opts.frame)); ctxId = f.ctxId; }
      const v = await evaluate(s, 'document.body ? document.body.innerText : ""', ctxId);
      out(String(v ?? '').replace(/\n{3,}/g, '\n\n').trim());
    });
  } else if (cmd === 'html') {
    await withPage(opts, { cmd: 'html', detail: opts.frame ? `frame:${opts.frame}` : '' }, async (s) => {
      let ctxId;
      if (opts.frame) { const f = await frameContext(s, String(opts.frame)); ctxId = f.ctxId; }
      out(await evaluate(s, 'document.documentElement.outerHTML', ctxId));
    });
  } else if (cmd === 'eval') {
    let expr = rest.join(' ');
    if (opts.file) expr = fs.readFileSync(String(opts.file), 'utf8');
    if (!expr) throw new Error('eval 需要表达式，或用 --file <路径>');
    await withPage(opts, { cmd: 'eval', detail: trim(expr, 70) }, async (s) => {
      let ctxId;
      if (opts.frame) { const f = await frameContext(s, String(opts.frame)); ctxId = f.ctxId; }
      out(await evaluate(s, expr, ctxId));
    });
  } else if (cmd === 'frames') {
    await withPage(opts, { cmd: 'frames', detail: '' }, async (s) => out(await listFrames(s)));
  } else if (cmd === 'wait') {
    const sel = rest[0];
    if (!sel && !opts.text) throw new Error('wait 需要 css 选择器，或 --text <片段>');
    const limit = num(opts.timeout, num(rest[1], 15000));
    await withPage(opts, { cmd: 'wait', detail: opts.text ? `text:${opts.text}` : sel }, async (s) => {
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
    await withPage(opts, { cmd: 'click', detail: trim(label) }, async (s) => {
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
    await withPage(opts, { cmd: 'fill', detail: `${sel} <- ${trim(text, 40)}` }, async (s) => {
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
    await withPage(opts, { cmd: 'shot', detail: trim(target) }, async (s) => {
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
