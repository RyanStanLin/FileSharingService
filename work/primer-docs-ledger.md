# File System 的 Primer 与设计核对

核对日期为 2026-11-21。项目使用 `@primer/react` 38.46.0、`@primer/primitives` 11.10.0、`@primer/octicons-react` 19.42.0。React 入口使用 `ThemeProvider`、`BaseStyles`、基础变量和 light 主题。

## 文档来源

首先读取 `primerdoc.init`。随后枚举并取回下列场景和 UI pattern 正文，再取回代码指南、token specs、token usage、色彩和排版指南。正式实现通过安装版的导出、声明和样式核对组件 API。官方基础资料包括 [布局](https://primer.style/product/getting-started/foundations/layout/)、[响应式](https://primer.style/product/getting-started/foundations/responsive/)、[内容](https://primer.style/product/getting-started/foundations/content/)、[主题配置](https://primer.style/product/getting-started/react/) 和 [无障碍](https://primer.style/accessibility/)。

| Pattern | 本项目的应用 |
| --- | --- |
| Copy、Delegate、Search | 已取回正文。这三个场景在本里程碑暂无对应操作。 |
| Create | 上传和新建目录在当前位置的对话框完成。提交失败保留输入。 |
| Customize、Filter | Columns 开关控制显示的数据列。隐藏文件选项直接更新目录的服务端查询。 |
| Delete | 菜单提供移到废纸篓。永久删除需要确认，递归删除需明确选择。 |
| Edit、Saving | 改名和移动明确提交。使用服务器条目版本和权限校验，操作失败可重试。 |
| View、Navigation | 面包屑和树共享同一个路径，浏览器前进和后退恢复相应位置。 |
| Data Visualization | 已取回正文。文件数据采用可排序表格。 |
| Degraded Experiences、Empty States | 锁定、离线、等待设备、无有效共享、空目录和请求失败使用对应状态。 |
| Feature Onboarding | 已取回正文。仅首次配置时提示输入部署密钥。 |
| Forms | 输入有可见标签、必填反馈、提交和取消。 |
| Loading、Notification message | 目录和任务提供读取状态，上传显示连续偏移的进度，失败通过可读消息反馈。 |
| Progressive disclosure | 文件操作用 ActionMenu，树节点打开时读取子项，列选择保留在原区域。 |

## 组件目录

`list_components` 实际返回 76 个去重名称。每个名称均请求 API、示例、用法和无障碍资料。下表的「已取回」表示返回了组件页面。跳到 Primer 首页的内容标为「未发布独立页」。官方回退核对明细在本机的 `.local/frontend-design/component-fallback.json`。粗体是本项目实际采用的组件。

对实际使用的组件，核对了对应示例、安装版属性和用法。Stack、SplitPageLayout、FormControl、Heading、Checkbox、Label、Spinner 和 ProgressBar 的缺失独立页面以组件概览、API 和对应的 Navigation、Forms、Loading 或排版指南覆盖。Dialog 的自定义头部保留官方 Escape 和焦点返回行为，并本地化关闭按钮。DataTable 使用外部排序、命名列和自定义的 Primer Checkbox 单元格保留独立的选中工具栏和两种语言的可访问名称。

| 组件 | API | 示例 | 用法 | 无障碍 |
| --- | --- | --- | --- | --- |
| ActionBar | 已取回 | 已取回 | 已取回 | 已取回 |
| **ActionList** | 已取回 | 已取回 | 已取回 | 已取回 |
| **ActionMenu** | 已取回 | 已取回 | 已取回 | 已取回 |
| AnchoredOverlay | 已取回 | 已取回 | 未发布独立页 | 工具返回无效 |
| Autocomplete | 已取回 | 已取回 | 已取回 | 未发布独立页 |
| Avatar | 已取回 | 已取回 | 未发布独立页 | 未发布独立页 |
| AvatarStack | 已取回 | 已取回 | 未发布独立页 | 未发布独立页 |
| Banner | 已取回 | 已取回 | 已取回 | 已取回 |
| Blankslate | 已取回 | 已取回 | 已取回 | 未发布独立页 |
| BranchName | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **Breadcrumbs** | 已取回 | 已取回 | 已取回 | 已取回 |
| **Button** | 已取回 | 已取回 | 已取回 | 已取回 |
| **IconButton** | 已取回 | 已取回 | 已取回 | 已取回 |
| **ButtonGroup** | 已取回 | 已取回 | 已取回 | 已取回 |
| Card | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **Checkbox** | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| CheckboxGroup | 已取回 | 已取回 | 已取回 | 已取回 |
| CircleBadge | 已取回 | 已取回 | 未发布独立页 | 未发布独立页 |
| ConfirmationDialog | 已取回 | 已取回 | 已取回 | 已取回 |
| CounterLabel | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **DataTable** | 已取回 | 已取回 | 已取回 | 已取回 |
| Details | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **Dialog** | 已取回 | 已取回 | 已取回 | 已取回 |
| FeatureFlags | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| Flash | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| **FormControl** | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| Header | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| **Heading** | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| Hidden | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| InlineMessage | 已取回 | 已取回 | 未发布独立页 | 未发布独立页 |
| KeybindingHint | 已查官网 | 已查官网 | 未发布独立页 | 未发布独立页 |
| **Label** | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| LabelGroup | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **Link** | 已取回 | 已取回 | 已取回 | 已取回 |
| NavList | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| Octicon | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| Overlay | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| PageHeader | 已取回 | 已取回 | 已取回 | 已取回 |
| PageLayout | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| Pagehead | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| Pagination | 已取回 | 已取回 | 已取回 | 已取回 |
| Popover | 已取回 | 已取回 | 已取回 | 已取回 |
| Portal | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| **ProgressBar** | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| Radio | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| RadioGroup | 已取回 | 已取回 | 已取回 | 已取回 |
| RelativeTime | 已取回 | 已取回 | 已取回 | 已取回 |
| SegmentedControl | 已取回 | 已取回 | 已取回 | 已取回 |
| **Select** | 已取回 | 已取回 | 已取回 | 已取回 |
| SelectPanel | 已取回 | 已取回 | 已取回 | 已取回 |
| SkeletonBox | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| SkeletonAvatar | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| SkeletonText | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **Spinner** | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **SplitPageLayout** | 已取回 | 已取回 | 未发布独立页 | 未发布独立页 |
| **Stack** | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| StateLabel | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| SubNav | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| TabNav | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| Text | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **TextInput** | 已取回 | 已取回 | 已取回 | 已取回 |
| TextInputWithTokens | 已取回 | 已取回 | 已取回 | 已取回 |
| Textarea | 已取回 | 已取回 | 已取回 | 已取回 |
| Timeline | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **ToggleSwitch** | 已取回 | 已取回 | 已取回 | 已取回 |
| Token | 已取回 | 已取回 | 已取回 | 已取回 |
| Tooltip | 已取回 | 已取回 | 已取回 | 已取回 |
| TopicTag | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| **TreeView** | 已取回 | 已取回 | 已取回 | 已取回 |
| Truncate | 已取回 | 已取回 | 未发布独立页 | 已取回 |
| **UnderlineNav** | 已取回 | 已取回 | 已取回 | 已取回 |
| AriaAlert | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| AriaStatus | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| FilteredSearch | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| IssueLabel | 未发布独立页 | 未发布独立页 | 未发布独立页 | 未发布独立页 |
| UnderlinePanels | 已取回 | 已取回 | 已取回 | 已取回 |

## Figma 和实现映射

- [FileSystem-Folder](https://www.figma.com/design/l9hmusc9x5sSYw59WQygO4/PrimerPlus?node-id=7880-24518) 的 MCP 返回 1280 × 950 框架与子节点几何。达到 Starter 配额后从 Figma 画布补看目录列表、隔行底色、列头、文件类型和菜单。画布约 70% 的缩放仅供位置和外观参照。
- [FileSystem-File](https://www.figma.com/design/l9hmusc9x5sSYw59WQygO4/PrimerPlus?node-id=7882-36694) 和 [FileSystemLocked](https://www.figma.com/design/l9hmusc9x5sSYw59WQygO4/PrimerPlus?node-id=7882-35968) 有完整设计上下文以及 1024 × 760 的渲染图。文件详情中的文档图标使用该设计提供的 PNG。浏览器以 Agent 返回的图片或 PDF 首屏显示真实预览。
- 采用 data-list 工作区。桌面顶栏目标 108 px，目录树 233 px，右侧概要 129 px，目录操作栏 65 px，路径栏 41 px。文件列表横向占满可用宽度。窄屏用 Primer Dialog 打开同一棵目录树，宽表由表格容器滚动。隐藏了窄屏中暂未开放的功能入口。
- Header 使用 Stack、UnderlineNav、ActionMenu 和 ToggleSwitch。SplitPageLayout 放置 TreeView 和内容区。Folder 视图使用 DataTable、Checkbox、Label 和 ButtonGroup。操作用 ActionMenu 和 Dialog，路径用 Breadcrumbs。安装版 UnderlineNav 会为辅助技术附加英文的 navigation 后缀。
- Commands、Data、Window Activity 和 FTP 凭据处于后续里程碑。目录菜单提供当前选择或文件夹的下载。Date Created 对应后端的 `createdAt`。

## 样式和组件边界

- 使用 `bgColor-default`、`bgColor-muted`、`bgColor-disabled`、`fgColor-default`、`fgColor-muted`、`borderColor-default`、`treeViewItem-leadingVisual-iconColor-rest`、`text-*-shorthand-*` 等安装版语义变量。
- 260 px 的命令占位、233 px 的侧栏、129 px 的概要、232 px 的行菜单与 10 px 的路径栏内边距按 Figma 测量设置。查阅过 `size`、`stack` 和 `overlay` 分组，现有配置没有对应的精确值。720 px 的可滚动表格宽度和 180 px 的窄屏预览高度是实现选择。顶栏 108 px 由 64 和 44 两个 Primer size token 合成。
- DataTable 按真实行序添加 muted 背景。末列紧凑内边距配合 medium 的 IconButton。原生文件选择器通过 Primer Button 打开，Primer 组件目录未提供 FileInput。
- 按 `list_icons` 和 `get_icon` 核对图标。业务图标使用 Octicons，包括 ThreeBars、FileDirectory、FileDirectoryFill、FileDirectoryOpenFill、File、FileSymlinkFile、Graph、Versions、Shield、ShieldCheck、ShieldX、Eye、EyeClosed、DesktopDownload、ChevronDown、KebabHorizontal、Pencil、FileMoved、Trash、X、Globe 和 ArrowLeft。命令占位用 Terminal，设计中的 command-palette 没有可用的当前 Octicon 条目。


## 验收

- `npm --prefix web run build` 完成严格 TypeScript 检查与 Vite 生产构建。Vite 报告 Primer 的客户端指令和包体积提示。
- 本机隔离 Chromium、ASP.NET Core 和 Swift Agent 的两条浏览器验收通过。 `test_filesystem_milestone_with_real_server_and_agent` 验证了虚拟 Passkey 注册、锁定和重解锁、权限请求、隐藏项、服务端排序、83 项分页、建目录、分块上传、改名、移动、下载字节、永久删除、PDF 首屏、中英文持久化和窄屏 Dialog 的 Escape 焦点返回。 `test_device_switch_archive_and_trash` 验证了切换两台真实 Agent、各自连接授权、ZIP 内容和废纸篓中的文件字节。
- 浏览器在 1280 × 950 下截图核对三个状态。顶栏分隔线与下方内容位于 y107–108，概要分隔线与下方内容位于 y236–237，路径栏分隔线位于 y909。原尺寸的目录页样本、字体渲染和实时文件内容存在差异。锁定、目录、行菜单、PDF 预览和窄屏截图保存在本机 `.local/frontend-check`。
- 窄屏检查覆盖 320、375 和 768 CSS px。375 px 下可从内容区打开目录树，页面无横向溢出。
- 最终五份 CSS 均调用了 `primerdoc.lint_css`。服务对这些样式及只含两个官方变量的对照样式都返回「Errors without autofix remaining」，诊断正文为空。独立 PostCSS 检查成功解析五份 CSS，105 处 token 引用均能在导入的 Primer 变量或项目尺寸定义中解析。手写前端文件少于 200 行。
- 浏览器验收使用隔离 HOME 的权限样本和虚拟验证器。生产硬件 Passkey 与真实受保护目录上的 macOS 弹窗需另行实机核对。
- 当第二台设备上线时保留当前设备，直到操作者从菜单切换或当前设备从清单移除。此行为已纳入双设备验收。
- Alt 文本工具需要当前连接未启用的 sampling。人工核对使用空 alt 的装饰文件图标，以及使用实际文件名的内容预览。
