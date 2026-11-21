# FileSharing Web

File System 是 FileSharing 的 Milestone 1 管理界面，使用 React、TypeScript 和 Primer React。左上角菜单用于选设备、管理当前设备的共享和切换语言。右上角 Access 开关通过 Passkey 管理会话。每台 Mac 的文件访问还需授权其当前连接。

## 本机运行

需要 Node.js 20.19+ 或 22.12+、npm 和 [本机 Demo 的依赖](../docs/local-demo.md)。

```bash
npm --prefix web ci
FILESHARING_DEMO_WEB_ORIGIN=http://localhost:5173 scripts/demo-server.sh start
npm --prefix web run dev
```

访问 [http://localhost:5173](http://localhost:5173)。如果 Demo 服务器已在 `http://localhost:8847` 模式运行，先结束正在使用的测试操作，再用 `scripts/demo-server.sh stop` 停止该实例，然后按上方命令启动。Mac Agent 仍连接 `http://localhost:8847`。原 Demo 页面在 Web 开发服务器的 `/demo`。

首次解锁时，从 `.local/demo/.env` 取得部署密钥，通过浏览器注册 Passkey。之后可直接使用已注册的 Passkey。选择在线设备并授权当前连接，即可浏览已共享目录。

## 文件访问

- Downloads、Documents 和 Desktop 显示 Agent 回报的 macOS 权限状态。进入需要授权的目录后可发起请求，并在目标 Mac 响应系统提示。
- 只读共享支持浏览和下载。写入需要 Mac 端批准可写范围，并在设备菜单的 Shared Folders 启用写入。默认 Demo 的 HOME 为只读。
- 支持目录树、隐藏项、列设置、服务端排序、分页、文件信息、图片和 PDF 首屏预览、直接下载和 ZIP 下载。
- 新建文件使用分块上传。改名、移动、移到废纸篓和确认后永久删除均通过服务端检查条目版本及权限。

## 构建

```bash
npm --prefix web run typecheck
npm --prefix web run build
```

静态产物位于 `web/dist`。提供静态文件的 HTTPS 来源应与服务端的 `FileSharing:Origin` 一致，并在同一来源转发 `/api/v1` 及其 WebSocket 请求。开发预览的后端地址可由 `FILESHARING_API_TARGET` 指定。

[API 契约](../docs/api.md) · [Primer 与设计核对记录](../work/primer-docs-ledger.md)
