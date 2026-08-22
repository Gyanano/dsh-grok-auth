# dsh-grok-auth

[English](README.md) | 中文

一个自包含的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Grok Auth** 插件。复用官方 **Grok CLI** 维护的 xAI OAuth 登录态
（`~/.grok/auth.json`，或 `$GROK_HOME/auth.json`），提供：

- `xai` LLM 路由（Grok 4.x 系列模型，走 `api.x.ai`，由 SuperGrok / X Premium
  订阅付费，无需 `xai-…` API key）；
- 原生 **Grok Auth** 设置区：登录状态、尽力而为的周额度用量、两种登录流程。

> **⚠️ 非官方通道——仅限个人开发使用。** 受账号门控的订阅接口
> （`auth.x.ai` 公开 CLI client、`cli-chat-proxy.grok.com` 计费端点）不受支持、
> 可能被撤销、限流或随时变更。请勿用于生产负载。

## 功能

### 共享 Grok 登录态

- 所有需要认证的操作共用一个 Host 侧协调器。
- 通过版本绑定的登录文件快照、短时内存缓存和过期前主动刷新
  （Grok token 约 6 小时有效期）解析凭证。
- 进程内合并并发刷新；OAuth 网络请求前后使用短临界区跨进程锁，仅当
  refresh token 谱系仍匹配时才落盘。DSH 侧锁使用插件自有的兄弟文件
  （`auth.json.dsh.lock`），因为官方 CLI 会在 `auth.json.lock`
  留下自有格式的持久锁文件。
- 兼容 Grok CLI 各版本的字段别名（`key`/`access_token`、
  `refresh_token`/`refresh`、`expires_at`/`expires`），写回时沿用文件
  已有的拼写。
- 插件自有的 `/grok-auth` Connection RPC 通道仅限 loopback，且不携带任何
  token 值。

### 一个授权来源，两种登录方式

- **浏览器登录**：派生官方 `grok login`，CLI 全权负责 PKCE 流程并写入
  自己的登录文件。
- **设备码登录**：在 Host 内执行 RFC 8628 流程（使用 CLI 内置的公开
  client id），设置卡上直接显示用户码和验证链接——无需 CLI，支持无头
  机器。批准后的 token 合并进 CLI 自己的文档。

### LLM 路由

`xai` 路由包装已安装的 pi-ai `xai` 目录 provider（`https://api.x.ai/v1`，
OpenAI 兼容协议）。订阅 OAuth access token 逐请求作为 Bearer 凭证注入——
与 pi-ai 自身 xAI 订阅登录相同的构造。线上协议、工具调用与流式传输均由
provider 负责。

### 在线模型发现

pi-ai 内置模型目录是随其版本固定的静态快照，新发布的 Grok 模型要等
pi-ai 升级才会出现。开启 `liveModels`（默认开启）后，插件会用账号的
真实 `GET api.x.ai/v1/models` 列表做叠加：目录里缺的聊天模型
（grok-4.6、grok-4.20 系列等）以目录中精选条目为模板合成，并带上线上
的上下文窗口和价格；发现的模型集合变化时路由会自动重新公告。精选目录
条目不会被修改，`grok-imagine-*` 图像/视频模型会被跳过。

### 周用量

设置卡展示来自 Grok 代理后端的尽力而为的周额度快照：

```text
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
```

任何失败都降级为占位符，绝不阻塞登录或请求。

## 前置要求

- DeepSeek Harness `0.1.1-rc.1` 或兼容的后续 `0.1.x` 版本。
- Node.js `^22.19.0` 或 `>=24.0.0`。
- SuperGrok / X Premium 订阅。
- `PATH` 上有官方 `grok` CLI（先执行一次 `grok login`），或直接使用
  Grok Auth 卡上的设备码登录。

## 安装预构建 Release（推荐）

Release 包内含预构建的 Host 与浏览器产物，安装时无需授予构建脚本权限：

```sh
dsh plugin --profile web add https://github.com/Gyanano/dsh-grok-auth/releases/download/v0.1.1/dsh-grok-auth-0.1.1.tgz
```

重启 `dsh web`，打开设置，选择 **Grok Auth**。

## 从 GitHub 源码安装

```sh
dsh plugin --profile web add github:Gyanano/dsh-grok-auth
```

Git 依赖由包的 `prepare` 脚本构建，而 pnpm 10+ 默认阻止该脚本——所以
**首次执行必定报错停止**（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）。注意
pnpm 自己的提示写的是 `onlyBuiltDependencies`，但 dsh 读取的允许清单是
`allowBuilds`。在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 中加入：

```yaml
allowBuilds:
  dsh-grok-auth: true
```

然后重新执行同一条命令即可。请在审阅过源码后再授予该权限。如需可复现
安装，可固定到 release tag 或 commit：

```sh
dsh plugin --profile web add github:Gyanano/dsh-grok-auth#v0.1.1
```

## 从 tarball 安装

```sh
git clone https://github.com/Gyanano/dsh-grok-auth.git
cd dsh-grok-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-grok-auth-0.1.1.tgz
```

重启 `dsh web`，打开设置，选择 **Grok Auth**。

## Host 配置

bundle patch 激活一行 Host 配置：

| 行 | 导出 | 用途 |
|---|---|---|
| `llm-grok-auth` | `dsh-grok-auth` | 共享认证协调器与 `xai` LLM 路由 |

所有字段均可省略。设 `llmEnabled: false` 可保留共享登录态协调器而不
占有 LLM 路由：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `llmEnabled` | `true` | 注册 `xai` LLM 路由 |
| `authJsonPath` | `''` → `$GROK_HOME`/`~/.grok/auth.json` | Grok 登录文件 |
| `credentialRef` | `GROK_OAUTH_TOKEN` | 状态卡展示的无值引用 |
| `refreshLeadMs` | `300000` | 刷新提前量（毫秒，与 CLI 默认一致） |
| `grokCommand` | `grok` | 用于浏览器登录与版本探测的 CLI 命令 |
| `displayName` | `xAI Grok (subscription)` | 模型选择器中的 provider 标签 |
| `baseUrl` | `''` | 端点覆盖；留空使用目录内置的 `api.x.ai/v1` |
| `timeoutMs` | `120000` | 请求超时（毫秒，`0` 表示禁用） |
| `liveModels` | `true` | 用账号的在线模型列表叠加内置目录 |

不要同时在 `llm-pi-ai.providers` 下添加 `xai` 条目；重复的路由所有权会被
显式诊断并拒绝。

## 安全与限制

- Token 值绝不进入浏览器、设置、日志、会话事件或工具元数据；只有 Host
  侧请求携带授权头。
- 状态可能包含 CLI 记录的账户邮箱与登录方式；这些是身份/状态事实，
  不是凭证。
- 刷新写入保留未知字段，并以仅属主可读写（`0600`）原子替换登录文件。
- 状态/登录 RPC 通道仅限 loopback。
- 官方 CLI 不参与插件的写者锁；保证是 fail-closed 恢复（谱系校验、
  采纳更新状态），而非绝对的跨客户端串行化。
- 公开 OAuth client id 属于官方 Grok CLI；xAI 未承诺其对第三方长期可用。

## 开发

```sh
pnpm install
pnpm run check
```

`pnpm run build` 产出：

- `lib/index.js` — Auth / LLM Host 插件；
- `lib/invariant.js` — 不变量伴生插件；
- `lib/client.js` — 兼容加载器的浏览器插件（内联 CSS Modules）；
- `lib/types/**` — 类型声明。

架构决策见 [ADR](docs/adr/0001-reuse-grok-cli-login-state.md)。

## 致谢

架构参考 [dsh-codex-auth](https://github.com/suntianc/dsh-codex-auth)；
设备码流程对齐 pi-ai 自身的 xAI OAuth 实现。
