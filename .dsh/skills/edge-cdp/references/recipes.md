# 配方

都要先有：`pwsh tools/doctor.ps1` 通过 + 自己的页签（下面用 `alice` 代替你的名字）。

## 1. 取正文（选择器兜底）

`text` 取的是 `document.body.innerText`，导航栏和页脚会一起混进来。要更干净就自己指定容器：

```powershell
node tools/cdp.mjs --tab alice eval "(() => {
  const sel = ['.content', 'article', '#main', '.main-content', 'body'];
  const el = sel.map(s => document.querySelector(s)).find(Boolean);
  return (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
})()"
```

先用 `eval "[...document.querySelectorAll('div')].slice(0,20).map(d=>d.className)"` 摸清 DOM 再说。

## 2. 表格 → JSON

```powershell
node tools/cdp.mjs --tab alice eval "(() => {
  const t = document.querySelector('table');
  if (!t) return { ok: false };
  const rows = [...t.querySelectorAll('tr')];
  const head = [...rows[0].cells].map(c => c.innerText.trim());
  return { ok: true, data: rows.slice(1).map(r =>
    Object.fromEntries([...r.cells].map((c, i) => [head[i] || ('c' + i), c.innerText.trim()]))) };
})()"
```

输出是 JSON，直接重定向存 `var/artifacts/x.json` 就行。要 CSV 就让 `eval` 返回逗号分隔的字符串。

## 3. 等动态列表加载完

三种等法，从稳到糙：

```powershell
node tools/cdp.mjs --tab alice wait ".item"                    # 等元素出现
node tools/cdp.mjs --tab alice wait --text "共 12 条"           # 等文字出现（更准，能等到数据渲染完）
node tools/cdp.mjs --tab alice eval "new Promise(r => setTimeout(r, 2000))"   # 实在没标志物才用
```

`wait` 未命中会返回 `{found:false}` 且**退出码 3**——脚本里可以据此判断，别当成功往下走。

## 4. 无限滚动到底

```powershell
node tools/cdp.mjs --tab alice eval "new Promise(r => {
  let last = -1, same = 0;
  const t = setInterval(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const h = document.body.scrollHeight;
    same = (h === last) ? same + 1 : 0; last = h;
    if (same >= 5) { clearInterval(t); r({ height: h, items: document.querySelectorAll('.item').length }); }
  }, 600);
  setTimeout(() => { clearInterval(t); r({ timeout: true }); }, 30000);
})"
```

## 5. 翻页抓全部

```powershell
# 第 1 页先抓，然后循环：点下一页 → 等列表变 → 再抓
node tools/cdp.mjs --tab alice click ".pager .next"
node tools/cdp.mjs --tab alice wait ".item"
```

判"换页了"别只看元素在不在（列表一直有），要记第一条的文字/链接，变了才算换页。
抓一批就先追加写文件，不要攒在内存里——中途崩了不至于全丢。

## 6. iframe 里的课件 / 播放器

```powershell
node tools/cdp.mjs --tab alice frames
# [
#   { "id": "ABC...", "url": "https://mooc1-1.chaoxing.com/ananas/modules/video/index.html?v=...", "name": "" }
# ]
node tools/cdp.mjs --tab alice --frame /ananas/modules/video/ text
```

`--frame` 的值要在 frame 列表里**唯一**，匹配多个会报错并列候选。
`--frame` 只影响读命令（`text` / `html` / `eval`）；要在 iframe 内部点或填，用 `eval` 在 frame 里做，
坐标点击只对主文档有效。

## 7. 判断是否还登录着

**不要读 cookie，不要碰 `var/profile/`。** 看页面本身：

```powershell
node tools/cdp.mjs --tab alice whoami
node tools/cdp.mjs --tab alice eval "document.body.innerText.includes('退出登录') || !!document.querySelector('.user-avatar')"
```

URL 被踹回 `/login` 或正文里出现登录表单，就是掉登录了——这时候该停下来告诉人，而不是去想办法绕过。

## 8. 长脚本走文件

表达式一长，PowerShell 的引号会把人逼疯。写到文件里：

```powershell
# 先把 JS 写进 var/artifacts/scrape.js，然后
node tools/cdp.mjs --tab alice eval --file var/artifacts/scrape.js
```

文件里的表达式必须是**单个表达式的值**（IIFE 或 Promise 都行），不要写 `return` 语句。

## 9. 截图取证

```powershell
node tools/cdp.mjs --tab alice shot var/artifacts/lesson-2.1.png
```

返回里带 `w`/`h`，长页面会自动整页截（`captureBeyondViewport`）。
交付给人时连尺寸一起说，方便判断是不是漏了底部。

## 10. 批量任务：先列清单再逐条

容易翻车的顺序是「边抓边决定抓什么」。稳妥的是三段：

1. 抓目录：`eval` 返回 `[{title, url}]`，存 `var/artifacts/manifest.json`；
2. 人过一眼清单（或至少打印条数让人确认）；
3. 逐条 `nav` → `wait` → `text`，每条落一个文件，失败的记进 `failures.json` 继续下一条。

中途出错不要重头再来——清单里已有 `done` 标记，跳过即可。
