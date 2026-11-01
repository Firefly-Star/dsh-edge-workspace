# dsh-edge-workspace

用 CDP（Chrome DevTools Protocol）驱动一台**受控的 Edge**：读页面、抓数据、真实点击与填表、截图取证。

它的设计前提是「**一台浏览器，多个 agent 共用**」——所以状态存在文件里而不是环境变量里，
页签可以认领和共享，每一次会改动页面的操作都由客户端强制记账。

> Windows 专用：工具链是 Windows PowerShell 5.1 + Edge + Node.js。

## 它解决什么问题

| 问题 | 这里的做法 |
|---|---|
| 每条命令都是新进程，环境变量传不下去 | 认领记录落在 `var/tabs/<页签id>.json`，跨命令、跨会话都在 |
| 多个 agent 抢同一台浏览器 | 页签「认领」：一个页签可以被多个名字同时认领 |
| 共享页签时互相把页面改了还不知道 | 改页面的命令由客户端强制写流水：谁、何时、做了什么、成没成 |
| 上一个 agent 挂了没收拾 | 引用计数：`close` 只释放自己那份，清零才真关 |
| 权限受限时脚本把「查不到」说成「没有」 | 所有探测区分「没有」和「unknown」，宁可报不确定也不撒谎 |

## 环境要求

- Windows 10 / 11
- Microsoft Edge
- Node.js **>= 22**（需要内置的全局 `WebSocket`，客户端零依赖）
- Windows PowerShell 5.1（脚本刻意只用 5.1 语法，且保持纯 ASCII）

## 快速开始

```powershell
# 1. 体检：node / Edge / 端口 / profile / 认领记录
powershell -NoProfile -ExecutionPolicy Bypass -File tools\doctor.ps1

# 2. 起浏览器（已经在跑会自动复用）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-edge.ps1
#    如果 agent 起不来（受限沙箱报 platform_channel.cc:187），让用户双击 tools\start-edge.cmd

# 3. 认领一个页签并操作
node tools\cdp.mjs newtab --tab alice https://example.com
node tools\cdp.mjs --tab alice text
node tools\cdp.mjs --tab alice shot work\demo\shots\example.png

# 4. 收工（只释放自己那份引用）
node tools\cdp.mjs close --tab alice
```

## 命令速查

认领与共享：

| 命令 | 作用 |
|---|---|
| `node tools/cdp.mjs tabs` | 列出页签、认领者、失效记录、损坏记录 |
| `newtab --tab <名字> <url>` | 新建页签并认领 |
| `claim --tab <名字> --target <id>` | 认领一个**已有**页签（可多人认领同一个） |
| `log --tab <名字> [--all]` | 这个页签的操作流水（谁·何时·做了什么） |
| `close --tab <名字>` | 释放引用；计数清零才真关，且只关本工作区新建的页签 |
| `prune` | 归档「无人认领且页签已消失」的记录到 `var/tabs/archive/` |

页面操作：

| 命令 | 作用 |
|---|---|
| `whoami` | 当前页签的 title / url / readyState / 认领者 |
| `nav <url>` | 导航并等到就绪 |
| `text` / `html` | 正文 / 整页 HTML |
| `eval <表达式>` | 在页面求值（`--file` 从文件读） |
| `click <css>` / `click --text "按钮文字"` | 真实鼠标点击（不是 `el.click()`） |
| `fill <css> <文本>` | 填值并触发 `input`/`change` |
| `wait <css>` / `wait --text "..."` | 等元素或文字出现（未命中退出码 `3`） |
| `frames` / `--frame <片段>` | 列出 iframe；读命令可进 iframe |
| `shot [文件]` | 截图，默认写 `work/shots/` |

通用参数：`--tab <名字>`、`--target <id>`、`--frame <片段>`、`--timeout <毫秒>`。
退出码：`0` 成功、`1` 出错、`2` 用法错、`3` `wait` 未命中。

## 目录结构

| 路径 | 内容 |
|---|---|
| `tools/cdp.mjs` | 唯一的 CDP 客户端，零依赖 |
| `tools/cdp-common.ps1` | 三个 PowerShell 脚本共享的探测逻辑（端口、进程、归属） |
| `tools/doctor.ps1` | 体检：node / Edge / 端口 / profile / 认领 |
| `tools/start-edge.ps1` `.cmd` | 幂等启动；`.cmd` 给用户双击（不受会话回收、不受沙箱限制） |
| `tools/stop-edge.ps1` `.cmd` | 只关本工作区的浏览器，不碰别人的 |
| `var/` | 运行时：浏览器 profile、日志、认领记录。**gitignored** |
| `work/` | agent 的产出目录。**默认不入库**，见 `work/README.md` |
| `.dsh/skills/edge-cdp/` | 给 agent 用的操作手册（技能） |

## 页签认领是怎么工作的

一个页签对应一条记录 `var/tabs/<targetId>.json`：

```json
{
  "id": "A1DFC844...",
  "url": "https://example.com/",
  "origin": "created",
  "claims": { "alice": { "since": "...", "lastUsed": "..." } },
  "log": [ { "at": "...", "who": "alice", "cmd": "nav", "detail": "https://example.org", "ok": true } ]
}
```

- `claims` 的键数就是**引用计数**；
- `origin` 分两种：`created`（本工作区新建，计数归零时会关闭）和 `adopted`（认领来的页面，**永远不会被关**）；
- `log` 由客户端自动写，不依赖 agent 自觉——`nav`/`click`/`fill`/`eval` 这类会改页面的命令
  必须带 `--tab`（有责任人），只读命令可以只用 `--target`；
- 写记录用原子替换 + pid 感知的文件锁，多个 agent 并发写不会互相覆盖。

## 安全边界

- **`var/profile` 是浏览器的登录态，等同密码**：不读、不导出、不提交（已在 `.gitignore`）。
- 调试端口**只绑 `127.0.0.1`**，不做端口转发、不开隧道。
- 命令集里**没有 `Browser.close`**——那会连坐整台浏览器，把所有人的会话一起断掉。
- `close` 只释放自己那份引用；还有别人认领就不会关；认领来的页面永远不替你关。
- 认领记录的 BOM/损坏会被明确报出来（`tabs` 里标 `corrupt`），不会静默丢掉归属。

## 已知限制

- iframe 内的真实点击/填写暂不支持：`--frame` 只对读命令（`text`/`html`/`eval`）有效，
  `click`/`fill` 只作用于主文档。
- 只有 Windows 实现。Linux/macOS 需要改 `start-edge` / `stop-edge`。
- `doctor` / `start-edge` / `stop-edge` 在**低完整性令牌**下（agent 沙箱）无法读取进程命令行和 TCP 表，
  这时会退化成 `netstat` + `DevToolsActivePort` 判定，并把结论标成 `unknown` 而不是猜。
