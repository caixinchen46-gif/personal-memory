# Personal Memory · 本地个人记忆

A local personal-memory service with source validation, scoped BM25 retrieval, durable storage and project-level Codex hooks.

为已接入的聊天保存和召回个人偏好、当前任务和有来源的经验。TypeScript + Express + sql.js，服务仅监听 `127.0.0.1`，记忆数据库保存在本机。

这是实验性项目，主要在 Windows + PowerShell + Node.js 24 下验证。桌面 Hook 和工具来源读取依赖客户端提供的事件与协议，不能保证所有客户端版本或其他操作系统都有相同行为。

## 功能

- 自然对话中的记忆候选由助手判断并提交，服务负责来源、隐私和类别校验；无需每次说“记住”。只有收到 `saved` 回执才表示该条已保存。
- 短期事件按北京时间当天有效；过期后转为历史记录，默认不召回，并非自动删除。中期记录项目任务和待验证经验，长期记录稳定信息和有验证支持的经验。
- 中文双字词及英文词的本地 BM25 检索，每次最多 5 条、上下文最多 6000 个 UTF-16 代码单元，支持个人及项目范围。
- 每条记忆保留 ID、原始来源摘录、时间和证据类别；显式更正保留新旧记录关系。
- sql.js 持久化、原子文件替换、幂等写入和迁移；Windows 命名管道防止同一数据库被多个服务或迁移器同时写入。
- 拦截识别到的凭据模式，敏感候选不直接保存；没有同意后保存敏感正文的接口。规则不能保证识别所有秘密。
- 服务不可用时 Hook 返回明确提示，聊天可以继续。

## 安装与启动

前提：Node.js 24 或以上、npm；桌面接入还需要支持对应 Hook 的 Codex 客户端。首次安装需要下载 npm 依赖；安装后记忆服务本身不调用云端 API。

在 PowerShell 中运行：

```powershell
git clone https://github.com/caixinchen46-gif/personal-memory.git
Set-Location personal-memory
npm ci
npm run check
npm test
npm run prepare:chat -- --runtime-dir "$PWD/data/runtime" --port 3002
npm start
```

准备命令创建随机凭据与 Hook 预览，不安装 Hook，也不覆盖已有配置。在 Windows 上，凭据目录限制为当前用户与 SYSTEM。服务保持在前台运行，Ctrl+C 停止。

另开终端检查状态：

```powershell
Invoke-RestMethod 'http://127.0.0.1:3002/api/status'
```

默认数据库为 `data/memory.db`，默认连接文件为 `data/runtime/connection.json`。可通过 `PM_DB_PATH`、`PM_RUNTIME_CONFIG`，或服务参数 `--runtime <绝对路径>` 指定。端口取自连接文件；更改端口必须同步更新该文件。

需要隐藏运行时，可以使用附带脚本：

```powershell
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-File', "$PWD/scripts/start-memory.ps1") -WorkingDirectory $PWD -WindowStyle Hidden
```

该脚本使用本仓库的默认数据路径，不创建开机自启或计划任务。仓库路径含空格时，建议使用前台 `npm start`。

## 接入当前项目聊天

默认准备命令允许本仓库目录作为聊天项目。确认 Hook 预览后，在本仓库另一个终端运行：

```powershell
New-Item -ItemType Directory -Path .codex -Force | Out-Null
if (Test-Path .codex/hooks.json) { throw '已有 Hook 配置，请手动合并，避免覆盖。' }
Copy-Item data/runtime/memory-hooks.preview.json .codex/hooks.json
```

在客户端审阅并信任 Hook，按客户端要求重新加载项目后台。配置使用 `UserPromptSubmit` 召回及生成提交指引，用 `Stop` 检查本轮是否有评估回执。项目 Hook 的格式和审阅规则以客户端当前版本为准。

接入其他项目时，在私有连接文件中配置真实的 `projectRoot`，以及可选的 `projectRoots` 绝对路径数组（最多 8 个），重启服务，再将生成的预览安装到相应项目。保持原始来源范围，不要通过改写历史记忆的 scope 来搬迁记录。这里不会安装全局 Hook。

停用时，将对应项目 `.codex/hooks.json` 改名并重新加载实际客户端后台。客户端可能缓存 Hook，仅改名不证明已停用。若已有其他 Hook，应只移除本项目添加的处理器。

## 数据与隐私边界

运行时目录、数据库、凭据、备份和本机 Hook 均被 `.gitignore` 排除。此仓库只包含源码与合成测试，不包含真实个人记忆或聊天记录。不要把自己的数据或连接文件添加到 Git。

记忆服务不调用云端模型，但召回文本会传给所接入的聊天客户端。若该客户端使用云端模型，相关记忆可能随上下文发送给其模型服务；本项目不控制聊天客户端的数据传输。

它不是完整聊天记录归档器，也不扫描或批量导入旧聊天。没有网页管理界面、学习计划、出题判分、自动提醒或向量语义检索。

## 验证与已知限制

```powershell
npm run check
npm test
```

当前共有 227 项自动化测试：规则 113、存储 23、聊天适配 76、独立服务及迁移 15。测试使用合成数据与临时数据库，覆盖保存、跨聊天召回、重启持久化、迁移冲突、鉴权、项目范围、数据库互斥和服务停用后的降级。

自动测试中的同轮第一次 `Stop` 提醒、第二次放行，不证明桌面中断按钮行为。`Stop` 完成生命周期与按钮中断应分别验收。工具来源接口不可用时返回降级结果，不得把缺少机器验证来源的经验当作 `verified`。

Linux/macOS 未完成实机验收；Unix 域套接字锁在异常退出后可能残留，需要先确认没有持库进程再处理。时间规则固定北京时间，不跟随使用者时区。

## 迁移已有记忆

迁移工具只导入 `personal_memories` 表，保留原始 ID、payload、来源及更正关系，不复制其他表。迁移时停止目标服务，先备份自己的数据库，再使用绝对路径：

```powershell
npm run migrate -- --source 'C:/path/to/source.db' --target 'C:/path/to/memory.db'
```

重复执行相同迁移不会新增重复记录；相同 ID 内容冲突时拒绝覆盖。迁移工具不会删除源文件。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方依赖遵循各自许可证。
