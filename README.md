# dsh-git-plugin

DSH（DeepSeek Harness）插件：**可视化 Git 提交历史**，并在 GUI 里直接完成 `add / commit / pull / push / merge` 等操作。

- **宿主半边**（`lib/`）：在 profile 的 `webServer` 上挂载 `/dsh-git/*`，提供静态页面与 JSON API，所有 git 命令都在宿主进程里执行。
- **客户端半边**（`client/`）：在左侧栏注册一个 **Git 页面**（`sidebar.panellist` 的图标 + `main` 键控面板），页面内嵌宿主提供的 SPA。
- **网页应用**（`web/`）：零构建的原生前端 —— 提交图（多泳道）、工作区、差异视图、提交框、拉取/推送/合并工具栏。

## 功能

| 区域 | 能力 |
|---|---|
| 提交历史 | 泳道图（自动布局/多分支）、ref 徽章（HEAD/分支/远程/标签）、作者与时间、搜索提交信息或作者、按路径过滤、`--all/--branches/--remotes/--tags` 范围、分页加载 |
| 提交详情 | 完整 sha、作者、时间、父提交、变化文件列表（含重命名）、整提交差异 |
| 工作区变更 | 已暂存 / 未暂存 / 未跟踪 / 冲突 分组，逐文件勾选，暂存、取消暂存、丢弃（含删除未跟踪文件）、全部暂存/取消暂存 |
| 提交 | 多行提交信息（走 stdin，编码安全）、`--amend`、`-a` 包含未暂存改动、`Ctrl/Cmd+Enter` 快捷提交 |
| 远程 | 抓取（`--prune`）、拉取（merge / rebase，可选 autostash）、推送（自动 `--set-upstream`、可选 `--force-with-lease`） |
| 分支 | 分支下拉切换、新建并切换分支、合并（`--no-ff` / `--ff-only` / `--no-commit` / 自定义合并信息） |
| 冲突与进行中状态 | 自动识别 merging / rebasing / cherry-picking / reverting，列出冲突文件，一键「全部标记为已解决（暂存）」，一键中止操作 |
| 其它 | 未跟踪文件的合成「new file」差异视图、大差异截断保护、仓库本地提交身份就地设置、每 10 秒可选自动状态刷新、`/api/selfcheck` 自检 |
| 跟随当前工作区 | 内嵌页面按宿主当前会话（`localStorage["dsh.sessions.current"]`）自动打开该会话所属工作区的仓库；会话切换时自动跟随，也可在工具栏手选其它仓库 |
| 右栏简要窗口 | 右侧边栏的一个独立 tab（kind `git-summary`）：当前仓库、分支、待推送/待拉取、冲突/已暂存/未暂存/未跟踪计数、最近提交；**只读**，另带「刷新」与「完整面板」。打开入口是左侧栏页脚的 `Git 简要` 按钮 |

## 安装

### 方式 A：手动放置 + patch 插入（本机已用此方式装好）

1. 把包放进目标 profile 的 `node_modules`：

   ```powershell
   # 本仓库所在目录，以及目标 profile 目录（按需替换）
   $plugin  = '<本仓库路径>'
   $profile = "$env:USERPROFILE\.dsh\profiles\desktop"

   # 用目录联接（推荐：只有一份源码，改完不必再复制）
   New-Item -ItemType Junction -Path "$profile\node_modules\dsh-git-plugin" -Target $plugin
   # 或者直接复制一份
   # Copy-Item -Recurse -Force $plugin "$profile\node_modules\dsh-git-plugin"
   ```

2. 在该 profile 的 `cordis.patch.yml` 末尾追加一个 **insert 行**：

   ```yaml
   - insert:
       - id: git-plugin
         name: dsh-git-plugin
         config:
           # 留空 = 自动选中宿主已知的第一个仓库（ctx.workspaceRegistry）；
           # 也可以写死某个仓库的绝对路径。
           repo: ''
   ```

   ⚠️ 必须是 `insert:` 列表形式，且 `name` 用**包标识符**（`dsh-git-plugin`，从 profile 的 `node_modules` 解析）。
   - 直接写 `- id: git-plugin` / `name: ...`（不带 `insert:`）会被 loader 判定为「patch 目标条目不存在」而**跳过**（实测日志：`dsh: [...cordis.patch.yml] patch: entry "git-plugin" not found`），插件不会装载。
   - `name` 写成插件目录的绝对路径也**不行**：loader 会把它转成 `file:` URL，而那是一目录，Node 拒绝目录导入（实测：`git-plugin (file:///...): failed to import`）。

3. 生效：宿主启用了 HMR（`@deepseek-ai/dsh-hmr` 由 base bundle 提供）时，**patch 一落地即热重组，无需重启**；本机实测 `dsh` 桌面宿主在写入后约 10 秒内挂载完成。也可先把条目写成 `disabled: true` 再删掉该行，用标准的禁用/启用路径触发一次重载。

4. 打开 GUI → 刷新页面（F5）→ 左侧栏出现 **Git** 图标。

先验证 patch 能被接受（不会真的启动）：

```powershell
& 'D:\software\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile desktop --dump-config | Select-String git-plugin
```

也可以完全不改 profile，用一次性 overlay 试装：

```powershell
dsh --profile <你的profile> web --patch '<本仓库路径>\install.patch.yml'
```

### 方式 B：通过 DSH 插件页安装

GUI →「设置 / Plugins」→ 插件管理页，来源填本目录的**绝对路径**（`plugin_manager` 支持绝对路径安装）。它会把包写进 profile 的依赖并作为 bundle 启用，profile 处于 live 状态时就地重组。

### 卸载

- 方式 A：删掉 `cordis.patch.yml` 里的 `insert` 块（HMR 立即卸载并释放全部路由），再删除 `node_modules\dsh-git-plugin`。
- 方式 B：在插件页卸载。

### 验证装载

```powershell
$b = 'http://127.0.0.1:19387'
# 1) 宿主半边：路由是否挂上、git 路径与仓库探测结果
(Invoke-WebRequest "$b/dsh-git/api/selfcheck" -UseBasicParsing).Content
# 2) 页面
Start-Process "$b/dsh-git/"
# 3) 客户端 bundle 是否被宿主提供（combo URL 里的 rev 见 selfcheck.client.row.url）
(Invoke-WebRequest "$b/plugins/??dsh-git-plugin/client.js&rev=<rev>" -UseBasicParsing).StatusCode
```

`selfcheck` 里 `client.composed=true` 即表示浏览器半边也已进入启动图。

## 配置

宿主条目支持以下可选配置（写在 `config:` 下）：

```yaml
- insert:
    - id: git-plugin
      name: dsh-git-plugin
      config:
        gitPath: 'D:\software\Git\Git\cmd\git.exe'   # 指定 git；默认自动探测
        repo: ''                                  # 默认仓库
        roots:                                        # 仓库白名单（留空=允许任意已存在的仓库）
          - 'D:\项目'
        trustedHosts: []                              # 额外信任的 Host（反向代理/局域网域名）
        logLimit: 200                                 # /api/log 默认页大小（10..500）
```

### 默认仓库的解析顺序

1. `repo` 非空 → 直接用它（必须是已存在的工作区仓库，此时 `session` 不参与）；
2. `repo` **留空或省略**，且请求带 `session=<会话 id>` → 该会话所属**工作区**的仓库（见下「跟随当前工作区」）；
3. 否则取 `ctx.workspaceRegistry` 里**第一个 Git 仓库**（宿主已知的工作区/项目目录）；旧宿主没有 `workspaceRegistry` 时该来源为空；
4. 都没有 → 若宿主进程的 `cwd` 本身是仓库就用它；
5. 仍然没有 → 接口报「没有可用的仓库：请先在界面上选择一个仓库路径」，可在面板工具栏切换仓库。

未知或空的 `session` 一律按「没有提示」处理，不会注入不存在的路径。

### 跟随当前工作区

面板要「打开你正在用的那个项目」，而宿主侧**没有**「当前工作区」这个概念 —— `ctx.workspaceRegistry` 只提供一份顺序稳定的工作区列表，不随活动变化。真正的「当前」只有浏览器里知道。所以两半配合：

1. `client/client.js` 读 `localStorage["dsh.sessions.current"]`（客户端 store `createSnapshotStore(..., { persist: { name } })` 的落盘格式就是 `{ sessionId }`），每 1.5 秒复查一次；
2. 变化时把 `?session=<id>` 传给内嵌页面（iframe 以 URL 为 key，值变才重载）；
3. `web/app.js` 首次取仓库列表时带上该参数；
4. 宿主用 `?session=` 在 `ctx.workspaceRegistry` 里找 `sessionIds` 含该会话的工作区（`WorkspaceEntity.sessionIds` 已被过滤为「cwd 校验通过」的会话），把它的路径提到候选列表最前。

任何一环缺失（旧宿主不认 `session`、localStorage 为空、会话找不到工作区）都只是退回「列表第一个仓库」，不会报错。带 `session` 时，上一次手选的仓库**不会**覆盖会话工作区 —— 想固定用别的仓库，就在工具栏选（该选择对不带 `session` 的访问仍然生效）。

本仓库自带的 `install.patch.yml` 用的就是 `repo: ''` 的自动探测形态，不改任何路径即可开箱使用。另注意 `roots` 非空时对**所有**请求（读与写）生效，只能指向白名单内的仓库。

### 右侧边栏的简要窗口

DSH 的右侧边栏是一个 **tab dock**，不是一个普通 slot：`rightbar` 那个座位由 `dsh-client-ui-sidebar-right` 自己占着，别的包不能直接往里塞内容。给该栏加内容的公开路径是**两步注册**，本插件照做：

1. **声明 tab 类型** —— `ctx.sidebarRightTabs.register({ id, kind, title })`，返回 disposer。`id` 是这套实现的身份（这里是 `dsh-git-plugin/summary`，同一 `id` 重复注册会抛错），`kind` 是打开时用的名字（`git-summary`）。
2. **注册该类型的 body** —— `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <id> }, Body)`，body 组件从框架注入的 `useTabInfo()` 拿到 `{ sidebar, panel, tab }`。

打开动作是 `ctx.sidebarRight.openTab('git-summary')`，本插件把它挂在**左侧栏页脚的 `sidebar.footer.action`** 上（`wide` 时显示文字，收起时只显示图标）。这两个服务都由右侧边栏包提供，所以整块注册包在 `ctx.inject(['sidebarRightTabs', 'sidebarRight'], ...)` 里 —— 没有右侧边栏的宿主会整块跳过，不影响主要的 Git 面板。

窗口内容只读：每 10 秒（外加手动「刷新」）取一次 `/api/repos?session=` → `/api/status` + `/api/log?limit=1`，渲染仓库名、分支、待推送/待拉取、冲突/已暂存/未暂存/未跟踪计数与最近提交；「完整面板」按钮调 `ctx.layout.selectPanel('git')` 切回左栏的完整界面。写操作全部留在完整面板里。

### 一处 CSS 陷阱（已修）

`web/index.html` 用 **`hidden` 属性**显隐面板，而 UA 样式表把 `[hidden]` 实现为 `display: none` —— 但**作者样式表里的任何 `display` 规则都会盖过 UA 规则**。`web/app.css` 里 `.pane`、`.backdrop`、`.busy` 都带 `display`，于是 `hidden` 完全失效：那个铺满整个面板的 `#busy` 一直亮着、转圈、显示初始文案 `处理中…`（`setBusy` 的默认文案），`#modal-backdrop` 和变更面板也一直显示。修法是在样式表最前面加一条 `[hidden] { display: none !important; }`。

### git 可执行文件探测顺序

1. `config.gitPath`；
2. `PATH`；
3. 常见安装位置（`%ProgramFiles%\Git\cmd\git.exe`、`%LOCALAPPDATA%\Programs\Git\cmd\git.exe`、`C:\software`、`D:\software` 及其一层子目录里的 `Git\cmd\git.exe` 等）；
4. 仍找不到时退回裸 `git`，由 `spawn` 报出可读错误。

本机解析结果为 `D:\software\Git\Git\cmd\git.exe` —— 该目录**不在 `PATH`** 里，所以自动探测是必需的。

## HTTP 接口

前缀 `/dsh-git`。读接口用查询参数，写接口用 JSON body（`repo` 字段可选，省略即用默认仓库）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-git/` | 页面 |
| GET | `/dsh-git/app.css`、`/dsh-git/app.js` | 静态资源 |
| GET | `/dsh-git/api/selfcheck` | 插件自检：git 路径、白名单、默认仓库、工作区目录、路由数、客户端 bundle 是否已进入启动图 |
| GET | `/dsh-git/api/repos` | 候选仓库、默认仓库、git 路径；`session=<会话 id>` 时 `defaultRepo` 跟随该会话所属工作区 |
| GET | `/dsh-git/api/info` | 仓库根、分支、上游、ahead/behind、远程、身份、进行中状态 |
| GET | `/dsh-git/api/status` | `status --porcelain=v2 --branch` 解析结果 + 进行中状态 + stash 数 |
| GET | `/dsh-git/api/log` | `limit/skip/ref/search/author/path` |
| GET | `/dsh-git/api/commit` | `sha` → 元数据 + 变更文件 + stat |
| POST | `/dsh-git/api/commit` | `message/amend/all/paths` |
| GET | `/dsh-git/api/diff` | `scope=worktree\|staged\|commit`、`path`、`sha`、`context` |
| GET | `/dsh-git/api/branches` | 本地/远程分支 + 上游跟踪状态 |
| POST | `/dsh-git/api/add` | `paths`（空数组=全部） |
| POST | `/dsh-git/api/unstage` | `paths` |
| POST | `/dsh-git/api/discard` | `paths`（未跟踪文件走 `clean -fd`） |
| POST | `/dsh-git/api/fetch` | `remote`、`branch` |
| POST | `/dsh-git/api/pull` | `remote/branch/mode=merge\|rebase\|ff-only/autostash` |
| POST | `/dsh-git/api/push` | `remote/branch/setUpstream/forceWithLease/tags/dryRun` |
| POST | `/dsh-git/api/merge` | `ref/noFf/ffOnly/squash/noCommit/message/abort/continueMerge` |
| POST | `/dsh-git/api/checkout` | `ref` |
| POST | `/dsh-git/api/branch` | `name/startPoint` |
| POST | `/dsh-git/api/abort` | `operation=merge\|rebase\|cherry-pick\|revert` |
| POST | `/dsh-git/api/identity` | `name/email`（写入仓库本地 `user.*`） |

`GET`/`POST` 同一路径（如 `/api/commit`）由**一条**路由按方法分发：宿主的 exact 路由表只以路径为键，同一路径注册两次会抛错并让整个插件装载失败。

返回统一为 `{ ok: true, ... }`；失败为 `{ ok: false, error, stderr, gitArgs, ... }`，HTTP 400（git 错误）或 500（未知错误）。

## 安全模型

- **只走 argv，不起 shell**：路径、分支名、提交信息全部作为独立参数传给 git，不做字符串拼接，因此不存在命令注入；提交信息通过 `git commit -F -` 走 stdin。
- **写接口同源防护**：与 `dshmarket` 相同的规则 —— `Host` 必须是 loopback（或配置的 `trustedHosts`），`Sec-Fetch-Site: cross-site` 直接拒绝，带 `Origin` 时必须与 `Host` 一致；缺 `Origin` 视为非浏览器调用而放行（桌面宿主代理会剥掉它）。
- **仓库白名单**：配置 `roots` 后，任何请求只能命名白名单内的仓库路径。
- **失败快速化**：子进程环境固定 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`、`GCM_INTERACTIVE=never`，凭据缺失立刻报错，不会把 GUI 卡在交互式提示上；本地命令 30s、网络命令 300s 超时并强杀进程。
- **输出有界**：单条 diff 截断到 1.5MB、前端最多渲染 6000 行；单个 git 输出上限 64MB。

## 测试

三套测试，前两套不需要 DSH 宿主（第三套需要一个运行中的宿主）：

```powershell
$P = '<本仓库路径>'

# 1) git 语义层：真实仓库 + 本地裸库，覆盖 push/pull/fetch/merge/冲突/中止（47 项）
node "$P\test\git-smoke.mjs"

# 2) HTTP 层：把真实路由表挂到 node http 服务上，验证接口、状态码、同源防护、白名单（68 项）
node "$P\test\http-smoke.mjs"

# 3) 在线客户端半边：对运行中的宿主校验启动图、bundle 可取、工厂注册与两个座位（26 项）
#    参数：<宿主地址> [launch token]
#    dsh web 宿主用首页的 __DSH_BOOT__；桌面宿主把首页挡在 token 网关后（401）时，
#    自动改用插件自己的 /api/selfcheck 取同一条启动图行，因此桌面宿主无需 token：
node "$P\test\client-bundle.mjs" http://127.0.0.1:19387
node "$P\test\client-bundle.mjs" http://127.0.0.1:4599 <token>
```

前两套会启动 git 子进程并捕获其输出，**在 DSH 的 workspace-write 沙箱下会以 `spawn EPERM` 失败**（沙箱禁止管道 stdio）；请在普通终端运行，或以 `danger-full-access` 运行。

本机验证记录（DSH `0.2.0-rc.2` 桌面宿主）：`47 + 68 + 26` 项全部通过，第 3 套直接从桌面宿主取 bundle 执行，断言工厂、`sidebar.panellist` / `main` 两个座位、locale 字典、图标 SVG、iframe 嵌入，以及有/无会话时的 `session` 参数。另在桌面宿主上确认 bundle 与应用页面均返回 200。

`repo: ''` 的自动探测行为单独验证 15 项：`repo` 省略 / `''` / 全空白三种写法都解析到 `workspaceRegistry` 提供的仓库，且 `/api/info`、`/api/repos`、`/api/status`、`/api/log` 全部正常。

「跟随当前工作区」另验证 9 项（把真实路由表挂到 node http 服务上，用桩 `workspaceForSession`）：带 `session` 时 `defaultRepo` 跟随该会话的工作区、`session` 字段回显、候选列表含该工作区；无 `session` / 未知 `session` / 空 `session` 都退回列表顺序；`session` 指向不存在的路径时不会被注入。客户端半边确认线上 bundle 的 `rev` 随 `client/client.js` 变更而变，且 bundle 里已含新代码。

## 目录结构

```
<本仓库路径>\                     ← 唯一源码目录（profile 里的安装是它的 junction）
├── package.json           dsh.client 声明 + "./client" 导出
├── install.patch.yml      可直接用的 --patch overlay
├── lib/
│   ├── git.js             git 操作层（零依赖、可单测）
│   ├── routes.js          HTTP 路由表（方法分发、同源防护、路径白名单、静态资源、自检）
│   └── index.js           宿主插件入口（ctx.inject(['webServer']) 挂载路由）
├── web/
│   ├── index.html         页面骨架
│   ├── app.css            自包含配色；内嵌时复制宿主 --dsw-alias-* 令牌
│   └── app.js             提交图布局、变更、差异、操作、模态框
├── client/
│   └── client.js          浏览器插件包（__ModuleLoader__ 工厂：侧栏图标 + main 页面）
└── test/
    ├── git-smoke.mjs
    ├── http-smoke.mjs
    └── client-bundle.mjs
```

## 已知限制

- **改 `lib/*.js` 必须重启宿主**：宿主的 HMR 只监听 profile 配置（`root: []`），不监听插件源码。改配置（如 `repo`）会当场热重组；但**改 `lib/*.js` 后「禁用→启用」并不能生效** —— 实测禁用后再启用，Node 的 ESM 模块缓存仍返回旧模块（`/api/repos` 的响应里没有新字段即为此证），必须重启 DSH 宿主才会重新导入。`client/client.js` 则会被 client-modules 的 HMR 按文件元数据识别，刷新页面即生效（bundle 的 `rev` 会变）。
- 提交图泳道按「已加载窗口」布局：父提交不在窗口内时按同一泳道向下画，加载更多后自然接续。
- 不做图形化 diff 合并编辑器；冲突解决走「编辑文件 → 全部标记为已解决（暂存）→ 提交」。
- 不主动管理凭据（不弹窗、不写凭据存储），HTTPS 远程依赖系统 git 凭据助手。
- 只支持工作区仓库（不支持裸库）；`git` 输出按 UTF-8 解码，diff 正文中的非 UTF-8 字节会显示为替换字符。
- `/api/repos` 的候选列表来自 `ctx.workspaceRegistry` 的项目目录与 `roots` 的一层子目录，最多各取 300 项。
