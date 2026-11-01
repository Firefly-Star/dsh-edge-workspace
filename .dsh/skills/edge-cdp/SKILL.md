---
name: edge-cdp
description: 用 CDP 驱动本工作区那台受控 Edge——读页面文字与表格、进入 iframe 取课件内容、真实点击与填表、截图取证、翻页抓取。任务要"看某个网页"或"在网页上点/填/抓"时用它。
whenToUse: 内容必须靠真实浏览器渲染、登录态或页面 JS 才能拿到时。静态公开页面先用 web_fetch，更省。
---

# Edge/CDP 操作手册

先确认三件事都在，再动手。跳过检查的代价是：命令报"连不上"，而你以为是网络问题。

```powershell
powershell -NoProfile -File tools\doctor.ps1        # 体检：node / Edge / 端口 / profile 锁
powershell -NoProfile -File tools\start-edge.ps1    # 已跑就复用，没跑就起一个
node tools/cdp.mjs newtab --tab alice https://你要去的地址
```

`alice` 换成你的名字。之后**每条命令都带 `--tab alice`**。

## 命令速查

| 目标 | 命令 |
|---|---|
| 看现在有哪些页签、谁认领了 | `node tools/cdp.mjs tabs` |
| 认领一个新页签 | `node tools/cdp.mjs newtab --tab 名字 <url>` |
| 我现在在哪个页面 | `node tools/cdp.mjs --tab 名字 whoami` |
| 跳转并等就绪 | `node tools/cdp.mjs --tab 名字 nav <url>` |
| 取正文 | `node tools/cdp.mjs --tab 名字 text` |
| 取结构 | `node tools/cdp.mjs --tab 名字 html` |
| 跑 JS | `node tools/cdp.mjs --tab 名字 eval "<表达式>"` |
| 跑长脚本 | 先写文件，再 `eval --file var/artifacts/x.js` |
| 列表在哪个 iframe | `node tools/cdp.mjs --tab 名字 frames` |
| 进 iframe 取正文 | `node tools/cdp.mjs --tab 名字 --frame <url 片段> text` |
| 真实点击 | `node tools/cdp.mjs --tab 名字 click "<css>"` |
| 填输入框 | `node tools/cdp.mjs --tab 名字 fill "<css>" "文本"` |
| 等元素/等文字 | `node tools/cdp.mjs --tab 名字 wait "<css>"` / `wait --text "已完成"` |
| 截图 | `node tools/cdp.mjs --tab 名字 shot var/artifacts/x.png` |
| 收工 | `node tools/cdp.mjs close --tab 名字` |

退出码：`0` 成功，`1` 出错（stderr 带 `ERROR:`），`2` 用法错，`3` 是 `wait` 超时未命中。

## 标准流程

1. **导航**：`nav <url>`，看返回的 `readyMs`。`TIMEOUT` 说明 30 秒内没到 `complete`——先别急着取内容，
   可能是登录跳转或弹窗挡着，`shot` 一张看看到底停在哪。
2. **定位**：`text` 先看整体；内容明显缺一块，多半在 iframe 里 → `frames` → `--frame`。
3. **提取**：能用 `text` 就别用 `html`（HTML 体积是正文的几十倍，白烧 token）。
   要结构化数据就用 `eval` 返回数组/对象，`cdp.mjs` 会自动 JSON 化。
4. **验证**：抓完回头 `whoami` 确认 URL 没被重定向跑偏；数量对得上再往下写。
5. **收尾**：产物写 `var/artifacts/`，`close --tab` 释放页签。

## 判据与红线

- **判断是否登录**：看页面文字/URL 是否被踹回登录页，**不要**去读 cookie 或 `var/profile/`。
- **没有 `--tab` 的多页签**：客户端会直接报错并列候选。这是保护，不是 bug——补 `--tab` 就是。
- **绝不 `Browser.close`**：那会关掉整台浏览器，其他人一起断。客户端没有这个命令。
- **不关别人的页签**：`close` 只认自己的认领记录。
- **不做提交类动作**：勾任务点、交测验、刷时长——被要求时说明并停下，把决定交回给人。

## 报错对照

| 报错 | 含义 | 处理 |
|---|---|---|
| `连不上 http://127.0.0.1:9222` | 浏览器没在跑 | `powershell -NoProfile -File tools\start-edge.ps1` |
| `8 秒无响应` | 端口被陈旧进程占着，服务是死的 | `powershell -NoProfile -File tools\stop-edge.ps1` 后重起 |
| `有 N 个页签，且没给 --tab` | 保护性拒绝 | 补 `--tab <你的名字>` |
| `页签 "x" 已经不在了` | 页签被关或浏览器重开过 | 重新 `newtab --tab x <url>` |
| `没有匹配 "..." 的 frame` | `--frame` 片段不对 | 先 `frames` 看真实 URL |
| `HTTP 405` | 用 GET 调了 `/json/new` | 客户端已用 PUT；别自己手搓 curl |
| `页面内异常：...` | 你的 JS 抛错了 | 缩小表达式，先 `eval "1+1"` 试通道 |

更细的配方看 `references/recipes.md`，坑的完整列表看 `references/pitfalls.md`。
