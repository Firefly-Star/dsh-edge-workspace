# 坑列表

按「现象 → 真正的原因 → 做法」记。每一条都是实际撞过的，不是想出来的。

## 1. 端口在监听，请求却不回包

```
ERROR: 8 秒无响应。端口可能被陈旧进程占着
```

**原因**：浏览器启动到一半就死了，但监听套接字被内核残留着。DPH 受限沙箱禁止创建命名管道（mojo），
Chromium 的多进程 IPC 建不起来，进程在 `platform_channel.cc:187` 抛 `Access denied (0x5)` 后崩掉。
于是出现"能连上、零字节返回"这种特别像网络问题的现象。

**做法**：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\doctor.ps1` 会明确标「陈旧端口」；
`powershell -NoProfile -ExecutionPolicy Bypass -File tools\stop-edge.ps1` 清掉再起。
判断服务活没活的唯一可靠依据是 `/json/version` 有没有返回 JSON，不是端口状态。

## 2. agent 自己起浏览器就崩

**原因**：同上——受限沙箱里 Chromium 起不来。

**做法**：让用户双击 `tools/start-edge.cmd`。从资源管理器启动的进程不在 DSH 的任务树里，
不会被会话回收，也不会拿到受限令牌。**顺带解决了生命周期问题**：浏览器不再跟着某个后台任务一起死。

## 3. `$env:CDP_TARGET` 设了却没用

**原因**：DSH 里每条命令都是新的 powershell 进程，环境变量不跨调用保留。
上一次会话那种"先设变量再跑命令"的写法，只有把两件事塞进**同一次**调用才成立，非常脆。

**做法**：用 `--tab <名字>`，认领记录落在 `var/tabs/<名字>.json`，跨进程、跨会话都在。

## 4. 截图截到上一屏的旧画面

**原因**：后台页签不产新帧。更隐蔽的是多 agent 并发：`Page.bringToFront` 会把别人的页签挤到后台，
于是大家轮流截到对方的旧帧。

**做法**：`shot` 里先等两帧再抓，且等帧有 1.5 秒上限（后台页签里 rAF 根本不跑）。
仍然旧就先 `nav` 重进一次。不要靠 `bringToFront`，那是在抢别人的焦点。

## 5. `el.click()` 点了没反应

**原因**：多数单页应用/富课件监听的是真实鼠标事件序列，不是 DOM 的 `click()`。

**做法**：`click` 命令走 `Input.dispatchMouseEvent`（mousePressed + mouseReleased），
先 `scrollIntoView` 再按元素中心坐标点。元素尺寸为 0 会直接报 `zero size`，多半是被 `display:none` 藏着。

## 6. 值填进去了，但提交后说没填

**原因**：直接 `el.value = x` 绕过了框架的值追踪。React/Vue 的受控组件只看得到自己 setter 里那次赋值。

**做法**：`fill` 用原型上的原生 setter 赋值，再派发 `input` + `change`。富文本（contenteditable）走另一条：
设 `textContent` 后派发 `InputEvent`。

## 7. 导航后永久卡在等加载

**原因**：先发 `Page.navigate` 再挂 `Page.loadEventFired` 监听——页面够快时事件已经过去了，监听永远等不到。

**做法**：不用事件，轮询 `document.readyState === 'complete'`（`cdp.mjs` 的做法）。慢就慢一点，不会卡死。

## 8. 第二个浏览器起不来，或者根本没开调试端口

**原因**：同一个 `--user-data-dir` 只能有一个实例。第二次启动会被已在跑的实例接管成一个新窗口，
命令行里的 `--remote-debugging-port` 被忽略——**看起来启动了，其实没开调试端口**。

**做法**：`start-edge.ps1` 先探活再启动，探到"同 profile 的进程在但不听端口"会明确报错让你先 `stop-edge`。

## 9. `newtab` 返回 405 Method Not Allowed

**原因**：Chromium 111+ 起 `/json/new` 只接受 `PUT`。

**做法**：`cdp.mjs` 已经用 PUT。自己写 curl / fetch 时别用 GET。
另外 URL 不要整体 `encodeURIComponent`——`?` 和 `#` 会被编掉。`cdp.mjs` 的做法是先用
`/json/new?about:blank` 建空页签，再用 `Page.navigate` 导航到真地址，完全绕开这个编码坑。

## 10. 页面明明有内容，`text` 却是空的

**原因**：内容在 iframe 里（课件、播放器、第三方嵌入基本都是）。

**做法**：`node tools/cdp.mjs frames` 看 frame 列表，读命令加 `--frame <url 片段>`。
注意 `--frame` 的值要唯一，匹配到多个会报错并列出来，别用太短的片段。
