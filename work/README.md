# work/ — agent 的工作目录

这是**唯一**该写你产出的地方。仓库根目录只放仓库自己的东西（`README.md`、`AGENTS.md`、`tools/`、`.dsh/`），
不要把抓下来的文件、截图、脚本直接丢在根目录。

## 怎么组织

**一个任务一个子目录**，名字用英文短横线：

```
work/
  chaoxing-final-exam/
    notes.md          # 这个任务是什么、做到哪一步、结论是什么
    data/             # 抓下来 / 导出的原始数据（json、csv、txt）
    shots/            # 截图证据
    scripts/          # 这次用过的一次性脚本
  course-video-2-1/
    notes.md
    shots/
```

- 不确定放哪时，先建 `work/<任务名>/`，再在里面按需分 `data/`、`shots/`、`scripts/`。
- 任务名用英文短横线（`final-exam`、`chapter-3-quiz`），不要用空格和中文标点，避免脚本里引用时踩引号。
- 一个任务收尾时，`notes.md` 要能让下一个人直接看懂：做了什么、关键数据在哪、有什么遗留问题。

## 多个 agent 协作同一个任务

**不要各自另起目录。** 同一个任务共用一个目录，用文件名前缀区分作者：

```
work/final-exam/
  alice-notes.md
  bob-data/questions.json
  shots/alice-before-submit.png
```

理由：任务是协作的边界，不是 agent。按 agent 分目录会让同一次任务的上下文被切成几份，
而按任务分目录，后来的人一眼就能看到全貌。

## 放什么 / 不放什么

| 放这里 | 不放这里 |
|---|---|
| 抓到的页面数据、导出的表格 | 仓库自身的文件（要改工具就去 `tools/`） |
| 截图、日志摘录 | 浏览器 profile、认领记录（在 `var/`，工具自己管） |
| 分析脚本、临时 JS | 散落在根目录的一堆文件 |

## 会不会被提交

**默认不会。** `.gitignore` 里 `work/*` 被忽略，只保留本 `README.md` 和 `.gitkeep`——
这样抓来的页面数据、含登录态的截图不会被误提交。

确实要入库的产出，显式加：

```powershell
git add -f work/final-exam/notes.md
```
