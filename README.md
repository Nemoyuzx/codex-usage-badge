# Codex Usage Badge · Codex 用量条

为 Codex 桌面端增加额度显示、项目配色、文件夹容量和会话 Token 统计，适配浅色与深色主题。

本仓库 fork 自 [jaykinhoo9/codex-usage-badge](https://github.com/jaykinhoo9/codex-usage-badge)，新增对话输入框下方的会话指标条。已有额度、项目与侧栏 Token 功能保留。

![Codex Usage Badge：原生风格额度圆环、项目配色与 Token 色块](assets/cover.png)

## 功能

- **额度圆环**：查看订阅剩余额度，绿、黄、红对应充足、偏低和即将耗尽。Plus 支持 5 小时与每周额度双圆环。
- **文件夹配色**：在项目菜单中选择颜色，方便区分不同项目。
- **文件夹容量（macOS）**：在本地项目名称旁显示目录占用，支持 KB、MB、GB 等单位，自动缓存并刷新。
- **会话 Token**：用蓝色色块表示用量，悬停查看累计 Token，按万、千万、亿显示。
- **输入框下方的会话指标**：显示当前本地会话的轮数、模型步骤、工具耗时、首 token 平均等待、缓存命中率和累计输入/输出 Token。被动监听 App 的实时事件，新增 `≈LLM` 响应阶段累计耗时和 `≈tok/s` 最近 5 次有效完整观测的平均速率；缺少数据的值留空。
- **每个会话保留最近状态**：已收集的数值按会话单独保存，停止运行、切换、临时读取失败或重新打开后恢复；本地 SQLite 保存全部已收集会话，不按最近 64 个淘汰。悬停可查看各项的采样时间，历史值不会冒充当前测速。
- **归档时清理指标**：归档会话后删除该会话的 SQLite 数值、浏览器缓存和内存指标；下次启动也会检查已归档记录。取消归档后重新收集，原始聊天记录保持不变。

`≈tok/s` 使用每次响应实际报告的输出 Token（含推理和工具参数），按观测到的响应阶段时间计算，并扣除可确认的工具执行区间。它包含桌面事件的传输/调度延迟，不能等同于严格的服务端 Token 生成速度；每次响应完成后更新，生成中不按字符数或消息块数冒充瞬时 Token 速度。`≈LLM` 仅累计本次监测中完整观测到的响应阶段，不回算旧会话历史。悬停指标条可查看口径和最近采样时间。

轮数、步数会随原生轮次/响应事件更新。历史轮数也从只读会话索引读取，步数按响应记录去重。`≥` 表示目前只确认部分历史或监测期间的下限；历史回填完成后显示完整总数。不会将监测下限与已有历史总数相加。
- **自动更新（macOS）**：每 6 小时检查 GitHub Releases，校验安装包后在后台升级，失败时恢复原版。

## 构建与安装

本 fork 的新增功能请从源码构建，上游已发布的安装包不包含指标条：

```bash
npm ci
npm run build
python3 scripts/build_release.py
```

构建后的安装包在 `dist/`，解压后按 [macOS 安装说明](docs/macos.md) 或 [Windows 安装说明](docs/windows.md) 安装。自动更新仅检查 [本 fork 的 Releases](https://github.com/Nemoyuzx/codex-usage-badge/releases)，不会安装上游版本。

macOS 和 Windows 安装后均可沿用原应用图标，启动时自动加载。Windows 后台在新窗口尚未开始操作时请求正常重开；点击、输入或后台启动时会跳过。需要已登录的 Codex 客户端和 Node.js 24+，安装器会优先查找客户端自带的运行环境。

[更新记录](CHANGELOG.md) · [问题反馈](https://github.com/Nemoyuzx/codex-usage-badge/issues) · [开发说明](docs/development.md) · [隐私与安全](SECURITY.md)

Windows v0.10.1 起默认从 GitHub Release 自动更新，可通过 `Update.cmd` 立即检查。旧版本需先手动升级一次；之后发布更高版本的 Windows 安装包和校验清单即可自动分发。[更新设置与发布方式](docs/windows.md)

非官方项目，与 OpenAI 无关联。采用 [MIT 许可](LICENSE)。
