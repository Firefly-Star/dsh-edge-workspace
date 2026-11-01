// Minimal reusable CDP client for Edge/Chrome launched with --remote-debugging-port (default 9222).
// Usage:
//   node cdp-cli.mjs tabs
//   node cdp-cli.mjs nav <url>
//   node cdp-cli.mjs eval <expression>
//   node cdp-cli.mjs text
//   node cdp-cli.mjs shot <out.png>
//   node cdp-cli.mjs click <css>
//   node cdp-cli.mjs fill <css> <text>
//   node cdp-cli.mjs wait <css> [timeoutMs]
//   node cdp-cli.mjs newtab <url>          # create own tab, prints {id, webSocketDebuggerUrl}
//   node cdp-cli.mjs close <targetId>
//
// Multi-agent use: give each agent its own tab, then scope commands to it:
//   $id = (node cdp-cli.mjs newtab https://chaoxing.com | jq -r .id)   # or parse manually
//   $env:CDP_TARGET = $id; node cdp-cli.mjs text
// When CDP_TARGET is unset, the first non-devtools page is used.
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

async function api(path, method = 'GET') {
  const r = await fetch(BASE + path, { method });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

async function pages() {
  const list = await api('/json/list');
  return (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = []; }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws open failed: ' + wsUrl));
      setTimeout(() => rej(new Error('ws open timeout')), 10000);
    });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && s.pending.has(msg.id)) { s.pending.get(msg.id)(msg); s.pending.delete(msg.id); return; }
      const hit = s.waiters.find((w) => w.method === msg.method);
      if (hit) { s.waiters = s.waiters.filter((w) => w !== hit); hit.resolve(msg); }
    };
    return s;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(method + ': timeout')); }, 30000);
    });
  }
  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('event timeout: ' + method)); }, timeoutMs);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function openPage() {
  const ps = await pages();
  let p;
  if (process.env.CDP_TARGET) {
    p = ps.find((t) => t.id === process.env.CDP_TARGET);
    if (!p) throw new Error('CDP_TARGET not found among page targets: ' + process.env.CDP_TARGET);
  } else {
    p = ps.find((t) => t.url && !t.url.startsWith('devtools://')) || ps[0];
  }
  if (!p) p = await api('/json/new?about:blank', 'PUT');
  const s = await Session.open(p.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  return s;
}

const [cmd, ...rest] = process.argv.slice(2);
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

try {
  if (cmd === 'tabs') {
    out((await pages()).map((p) => ({ id: p.id, title: p.title, url: p.url })));
  } else if (cmd === 'newtab') {
    const url = rest[0] || 'about:blank';
    const t = await api('/json/new?' + encodeURIComponent(url), 'PUT');
    out({ id: t.id, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl });
  } else if (cmd === 'close') {
    out(await api('/json/close/' + rest[0]));
  } else if (cmd === 'nav') {
    const url = rest[0];
    const s = await openPage();
    await s.send('Page.navigate', { url });
    await s.once('Page.loadEventFired', 25000).catch(() => {});
    const r = await s.send('Runtime.evaluate', { expression: '({title: document.title, url: location.href})', returnByValue: true });
    out(r.result.value);
    s.close();
  } else if (cmd === 'eval') {
    const s = await openPage();
    const r = await s.send('Runtime.evaluate', { expression: rest.join(' '), returnByValue: true, awaitPromise: true });
    out(r.result && 'value' in r.result ? r.result.value : r);
    s.close();
  } else if (cmd === 'text') {
    const s = await openPage();
    const r = await s.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
    out(r.result.value);
    s.close();
  } else if (cmd === 'shot') {
    const file = rest[0] || 'shot.png';
    const s = await openPage();
    await s.send('Page.bringToFront').catch(() => {});
    await new Promise((r0) => setTimeout(r0, 400));
    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    out({ saved: file, base64Len: r.data.length });
    s.close();
  } else if (cmd === 'click') {
    const sel = JSON.stringify(rest[0]);
    const s = await openPage();
    const r = await s.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${sel}); if (!el) return {ok:false, why:'not found'}; el.scrollIntoView({block:'center'}); el.click(); return {ok:true, tag: el.tagName, text: (el.innerText||'').slice(0,80)}; })()`,
      returnByValue: true,
    });
    out(r.result.value);
    s.close();
  } else if (cmd === 'fill') {
    const sel = JSON.stringify(rest[0]);
    const text = JSON.stringify(rest.slice(1).join(' '));
    const s = await openPage();
    const r = await s.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${sel}); if (!el) return {ok:false, why:'not found'}; el.focus(); el.value = ${text}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true, tag: el.tagName, value: el.value}; })()`,
      returnByValue: true,
    });
    out(r.result.value);
    s.close();
  } else if (cmd === 'wait') {
    const sel = JSON.stringify(rest[0]);
    const limit = Number(rest[1] || 15000);
    const s = await openPage();
    const t0 = Date.now();
    let found = false;
    while (Date.now() - t0 < limit) {
      const r = await s.send('Runtime.evaluate', { expression: `!!document.querySelector(${sel})`, returnByValue: true });
      if (r.result.value) { found = true; break; }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    out({ found, ms: Date.now() - t0 });
    s.close();
  } else {
    console.error('unknown cmd. use: tabs | nav <url> | eval <expr> | text | shot <file> | click <css> | fill <css> <text> | wait <css> [ms]');
    process.exit(2);
  }
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}
