# 配方

都要先有：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\doctor.ps1` 通过 + 自己的页签（下面用 `alice` 代替你的名字）。

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

输出是 JSON，直接重定向存 `work/<任务>/data/x.json` 就行。要 CSV 就让 `eval` 返回逗号分隔的字符串。
（所有产出都放 `work/`，`var/` 是工具的运行时目录，别往里塞东西。）

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

`--frame` 只对**读**命令有效：`text` / `html` / `eval`（`wait` 也不进 frame）。
`click` / `fill` 不接受 `--frame`，只作用于主文档——iframe 里点按钮、填输入框，目前只有一条退路：
在 frame 里用 `eval` 派发 DOM 事件。

这条退路有代价：`el.click()` 对监听真实鼠标事件的单页应用/课件常常无效（见 pitfalls #5）。
iframe 里的东西点不动时别硬试——找到它绑定的处理函数用 `eval` 触发，或者反馈让 `click` 支持 `--frame`。

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
# 先把 JS 写进 work/<任务>/scripts/scrape.js，然后
node tools/cdp.mjs --tab alice eval --file work/我的任务/scripts/scrape.js
```

文件里的表达式必须是**单个表达式的值**（IIFE 或 Promise 都行），不要写 `return` 语句。

## 9. 截图取证

```powershell
node tools/cdp.mjs --tab alice shot work/我的任务/shots/lesson-2.1.png
```

返回里带 `w`/`h`，长页面会自动整页截（`captureBeyondViewport`）。
交付给人时连尺寸一起说，方便判断是不是漏了底部。

## 10. 批量任务：先列清单再逐条

容易翻车的顺序是「边抓边决定抓什么」。稳妥的是三段：

1. 抓目录：`eval` 返回 `[{title, url}]`，存 `work/<任务>/data/manifest.json`；
2. 人过一眼清单（或至少打印条数让人确认）；
3. 逐条 `nav` → `wait` → `text`，每条落一个文件，失败的记进 `failures.json` 继续下一条。

中途出错不要重头再来——清单里已有 `done` 标记，跳过即可。

## 11. 提交类动作（不可逆，固定按这个顺序）

勾任务点、交测验都是本工作区的正常任务，但提交按钮点一次就是一次，重复提交会把测试数据弄脏。四步走。

**第一步：先看清要交什么。** 别上来就点。

```powershell
node tools\cdp.mjs --tab alice eval "(() => {
  const qs = [...document.querySelectorAll('.question, .TiMu, .subject, li')];
  return qs.slice(0, 20).map((n, i) => ({ i, text: (n.innerText || '').replace(/\s+/g, ' ').slice(0, 100) }));
})()"
```

**第二步：存一张「提交前」的截图。** 出问题时只有它能证明当时是什么状态。

```powershell
node tools\cdp.mjs --tab alice shot work\我的任务\shots\before-submit.png
```

**第三步：按文字点，别猜 class。** 中文按钮的 class 常是随机哈希，文字才是稳定的：

```powershell
node tools\cdp.mjs --tab alice click --text "提交"
```

点完等结果文字出现（不是死等固定秒数）：

```powershell
node tools\cdp.mjs --tab alice wait --text "已提交"
```

**第四步：留证并报告。** 截图 + 把分数/提示语读出来，写进结论。

```powershell
node tools\cdp.mjs --tab alice shot work\我的任务\shots\after-submit.png
node tools\cdp.mjs --tab alice eval "document.body.innerText.slice(0, 500)"
```

### 注意

- 提交后**不要**因为没看到预期文字就再点一次。先 `shot` 看一眼——可能已经在「提交成功」页上了。
- 二次确认弹窗用 `click --text "确定"` 点，别用 `eval "confirm()"` 糊弄：那绕过真实交互路径，测不到真问题。
- 一次交多题时，先数一遍已选项和题目数对不对得上，再点提交。
- `click --text` 先找 `button/a/[role=button]`，找不到才退到只含文字的叶子节点——所以按钮里嵌了图标也点得中；
  但页面有两个同文字按钮时只会点第一个，需要精确时改用 css。
