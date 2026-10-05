# 开发与验证

## 发布 macOS 自动更新

更新 `package.json`、`package-lock.json`、`src/agent-main.js` 和 `manage.cjs` 中的 macOS 版本号后，运行 `python3 scripts/build_release.py --platform macOS`。构建器生成包含 `update.json` 和校验清单的安装包。

通过测试与隐私检查后，以 `v版本号-macos` 标签发布 GitHub Release，上传 `CodexUsageBadge-macOS-版本号.zip` 和外部 `SHA256SUMS.txt`。只有已发布、安装包上传完整且具有 GitHub SHA-256 digest 的 Release 会被发现。草稿、仅推送源码、Windows 包及不高于本机版本的包不会触发升级。当前 macOS 渠道默认包含预发布版本。

`updater/core.cjs` 负责筛选版本、下载校验、ZIP 校验和缓存锁；`updater/worker.cjs` 调用现有安装器。安装器在独立操作锁内迁移程序，保持正在运行的更新器存活，并在后台启动失败时恢复原文件与服务。更新包在临时缓存目录验证，安装结束后清理。

## 本地开发

开发环境：Node.js 24+、Python 3.10+。macOS 原生助手由 Xcode Command Line Tools 编译为 arm64 / x86_64 通用程序；普通用户使用安装包中的成品，无需编译。

```bash
npm ci
npx playwright install chromium --only-shell
python3 scripts/build_release.py
npm test
npm run test:privacy
```

macOS 额外运行原生测试：

```bash
node tests/startup-native.cjs .devtools/macos-startup-bridge
```

PowerShell 测试：`pwsh -File tests/windows.ps1`。Windows CI 还会运行 `tests/windows-native.ps1`，验证安装、快捷方式、后台停止和卸载。

Windows 启动适配器测试：`powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-startup-native.ps1`。它仅操作临时隐藏应用，检查进程身份、Raw Input 活动分类、正常退出/拒绝及重开。`startup/` 为 Windows 适配器；macOS 保持原有 `macos/startup/` 实现。

只构建 Windows：`python scripts/build_release.py --platform Windows`。其版本取自 `package.json` 的 `windowsVersion`，不修改 macOS 的 `version` 或已有发布附件。Windows 发布使用 `v<版本>-windows` 标签，只上传 Windows ZIP 和该 ZIP 的校验文件。

`build_release.py` 在 macOS 生成两个平台的 ZIP，在 Windows 生成 Windows ZIP。文件输出到 `dist/`，附带 SHA256 校验清单。发布前将本次源码加入 Git 暂存区，再执行隐私检查；检查覆盖所有受跟踪源码和安装包。

## 数据与兼容性

额度来自客户端 CLI 的账号接口。Plus 显示短周期与每周额度，Pro 显示周额度；大于 50% 为绿、10%～50% 为黄、小于 10% 为红。

Token 读取本机会话数据库中的累计值，包含缓存输入，不代表当前上下文大小。色块的四档分界为 100 万、1000 万和 1 亿；无记录时为灰色。额度约每分钟刷新，Token 约每 5 秒刷新。

本 fork 在输入框下方新增指标条，约每 5 秒刷新当前可见的本地 Codex 会话。`src/thread-metrics-ui.js` 通过可见的 thread composer 和它的 conversation ID 识别当前会话，云端、ChatGPT 与远程会话不读取本机同名数据。`src/thread-metrics-reader.js` 只读最新 `state_*.sqlite` 的会话 ID/rollout 路径，再分批读取本地 JSONL；渲染器只收到该窗口当前会话的数值汇总。

历史指标定义：轮数来自有唯一 turn ID 的任务开始/完成事件；步数来自完成的模型响应记录，按 response ID 去重。旧版日志的步数通过去重后的累计 Token 记录推断。工具耗时来自同一 call ID 的工具调用与返回时间戳，重叠区间合并，因此包含工具等待时间。首 token 平均为已完成轮次记录的 `time_to_first_token_ms` 均值。缓存命中率是累计缓存输入 Token / 累计输入 Token，输入/输出是日志报告的会话累计值，包含推理输出。优先使用新版 `token_usage_record`，旧记录按支持的事件退化；缺失或尚未扫描完整的计数/耗时留空，不以部分历史冒充完整统计。

实时监测通过 `src/thread-performance-ui.js` 被动监听预加载层向窗口分发的 `mcp-notification`：只接受原生来源（`source === null`、空 origin）、Electron 客户端和 `hostId === 'local'`，将生命周期 ID/类型/数值投影给可独立测试的 `createThreadPerformanceTracker`。不订阅新的推理、不改变客户端原有处理器。当前客户端主动禁用了 `rawResponse/completed` 通知，而且转发时未保留 `emittedAtMs`，因此不能当作严格的服务端生成测速。

`≈tok/s` 的每个有效样本使用 `thread/tokenUsage/updated.tokenUsage.last.outputTokens`，包含推理输出和工具参数。分母为本次响应最早完整观测的模型 item `startedAtMs` 至用量通知到达的时间，扣除其中可确认的工具执行时间并集；前端按最近 5 个有效样本的 `sum(outputTokens) / sum(durationMs) * 1000` 显示加权速率。它包含该观测阶段内的等待和通知传输/调度延迟，不包含首个模型 item 之前的时间，也不代表逐 Token 的瞬时生成速度。`≈LLM` 是当前有效监测时段内通过校验的响应阶段耗时累计，不与旧会话历史混加。提示中显示监测起点、最近样本时间和有效响应数。

中途安装先等首个用量通知建立基线，之后捕获完整响应即可采样。重复用量、缺失推理生命周期、过时事件、无法分离的模型/工具重叠、计数回退等均不新增样本；普通不完整响应保留此前的有效均速，连接/可见性中断及重放/异常连续性会清空相应监测窗口。历史首 token 平均仍使用显式日志计时，不以 item 起点冒充 TTFT。更改 tracker 工厂或监听器时同步递增监听器版本，确保已有窗口重新安装正确代码。

本 fork 的更新器与构建清单固定指向 `Nemoyuzx/codex-usage-badge`。从上游合并更新时保留此来源，否则上游发布包会移除 fork 功能。

项目容量按本机项目路径计算，macOS 使用目录占用统计；默认两路并发，缓存 5 分钟，单项目计算最多 3 分钟。不可访问的目录显示 `—`，不以不完整结果冒充完整容量。

插件依赖客户端内部界面和调试接口。自动化测试使用临时目录、模拟页面与独立测试应用，不读取真实账号。本 fork 已验证本机 macOS App 的真实输入框下方放置和本地数据读取。上游报告 macOS 自动加载已完成本机真实客户端重启验证、Windows 安装流程由 CI 验证；本 fork 的真实 Windows 客户端显示及长期兼容性仍需更多设备反馈。
