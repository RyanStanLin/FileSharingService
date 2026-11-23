# File System 的 Primer 与设计核对

核对日期为 2026-11-22。项目使用 `@primer/react` 38.46.0、`@primer/primitives` 11.10.0、`@primer/octicons-react` 19.42.0。`ThemeProvider` 和 `BaseStyles` 使用系统配色，标准和高对比度各有一套亮色与暗色变量。应用会保存对比度偏好。 [Primer 主题](https://primer.style/product/getting-started/react/theming/)

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

对实际使用的组件，核对了对应示例、安装版属性和用法。Stack、SplitPageLayout、FormControl、Heading、Checkbox、Label、Spinner 和 ProgressBar 的缺失独立页面以组件概览、API 和对应的 Navigation、Forms、Loading 或排版指南覆盖。Dialog 的自定义头部保留官方 Escape 和焦点返回行为，并本地化关闭按钮。此次重新核对 SplitPageLayout 的 `resizable`、`width` 和 `widthStorageKey`，使用其分隔线、指针与方向键交互。 [SplitPageLayout](https://primer.style/product/components/split-page-layout/)

| 组件 | API | 示例 | 用法 | 无障碍 |
| --- | --- | --- | --- | --- |
| ActionBar | 已取回 | 已取回 | 已取回 | 已取回 |
| **ActionList** | 已取回 | 已取回 | 已取回 | 已取回 |
| **ActionMenu** | 已取回 | 已取回 | 已取回 | 已取回 |
| AnchoredOverlay | 已取回 | 已取回 | 未发布独立页 | 工具返回无效 |
| **Autocomplete** | 已取回 | 已取回 | 已取回 | 以 WAI-ARIA Combobox 指南核对 |
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
| DataTable | 已取回 | 已取回 | 已取回 | 已取回 |
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
- FileSystem-File 和 FileSystemLocked 有完整设计上下文以及 1024 × 760 的渲染图。文件图标和预览使用 Agent 返回的逐文件 PNG。 [FileSystem-File](https://www.figma.com/design/l9hmusc9x5sSYw59WQygO4/PrimerPlus?node-id=7882-36694) · [FileSystemLocked](https://www.figma.com/design/l9hmusc9x5sSYw59WQygO4/PrimerPlus?node-id=7882-35968)
- 桌面顶栏目标 108 px，目录树默认 233 px，可在 176–480 px 内调整，右侧概要 129 px，路径栏 41 px。侧栏标题用 1 px 分隔线，隐藏项按钮填满选项区域。窄屏用 Primer Dialog 打开同一棵目录树，宽表可以横向滚动。
- Header 使用 Stack、UnderlineNav、ActionMenu 和 ToggleSwitch。SplitPageLayout 放置 TreeView 和内容区。右侧按 Figma 自定义语义表格，排序、复选、标签和菜单沿用 Primer 控件。操作用 ActionMenu 和 Dialog，路径用 Breadcrumbs。安装版 UnderlineNav 会为辅助技术附加英文的 navigation 后缀。
- Commands 和 FTP 凭据处于后续里程碑。目录菜单提供当前选择或文件夹的下载。Date Created 对应后端的 `createdAt`。

## 样式和组件边界

- 使用 `bgColor-default`、`bgColor-muted`、`bgColor-disabled`、`fgColor-default`、`fgColor-muted`、`borderColor-default`、`treeViewItem-leadingVisual-iconColor-rest`、`text-*-shorthand-*` 等安装版语义变量。
- 260 px 的命令占位、233 px 的侧栏、129 px 的概要、232 px 的行菜单与 10 px 的路径栏内边距按 Figma 测量设置。查阅过 `size`、`stack` 和 `overlay` 分组，现有配置没有对应的精确值。可滚动表格的最小宽度为 720 px。桌面顶栏 108 px 由 64 和 44 两个 Primer size token 合成，工作区随实际顶栏高度和窗口调整。
- 自定义表格采用 28 px 列头、36 px 文件行、独立的复选、文件图标与菜单列，以及偶数行的 `bgColor-muted`。选中栏展开至 65 px，取消选择时收起，跟随系统的减少动态效果设置。原生文件选择器通过 Primer Button 打开，Primer 组件目录未提供 FileInput。
- 按 `list_icons` 和 `get_icon` 核对图标。业务图标使用 Octicons，包括 ThreeBars、FileDirectory、FileDirectoryFill、FileDirectoryOpenFill、File、FileSymlinkFile、Graph、Versions、Shield、ShieldCheck、ShieldX、Eye、EyeClosed、DesktopDownload、ChevronDown、KebabHorizontal、Pencil、FileMoved、Trash、X、Globe 和 ArrowLeft。命令占位用 Terminal，设计中的 command-palette 没有可用的当前 Octicon 条目。

## 目录读取

- Agent 的文件 I/O 使用串行队列，Agent 与 Broker 都限制未完成指令数。前端先请求列表，目录树复用当前目录数据，轻量元数据在后台读取。只有在「查看信息」主动触发时才递归扫描目录。订阅回执及相同快照版本会被跳过，实际目录变更合并为一次刷新。
- 同一页面按设备排队执行列表和轻量元数据读取，优先处理当前操作。读取受限时依照 `Retry-After` 和短退避重试，设备短时超时可自动恢复一次。滚动到列表底部时加载后续页。遇到快照冲突会从首屏刷新，连续失败可以手动重试，已读取项目保留在列表中。
- 可见文件按版本获取缩略图，同一设备连接内的树、列表和详情复用内存缓存。缩略图优先级低于路径、列表和元数据请求。图片和 PDF 优先渲染内容，其他类型由 Agent 提供 macOS 文件类型图标。
- 缩略图分别受列表 20 px、树 16 px、详情图标 32 px 的宽高限制，保留原始比例。图片预览内的 Primer Button 按需启动带文件版本校验的传输，将原图直接交给浏览器图像组件。等待或失败期间保留缩略图。 [Primer Loading](https://primer.style/product/ui-patterns/loading/)
- File System 的分页观察器以右侧列表为根。页面使用视口高度，工作区占用标题栏下方的余高，文件行和加载指示在列表内滚动。

## 选择和路径跳转

- 自定义文件表格保留 Primer Checkbox 作为可访问的选择控件。整行支持单击、⌘ 切换单项、Shift 范围和按住拖动框选。选择状态使用 `bgColor-accent-muted`，选框使用语义边框颜色，位置和尺寸随指针变化。⌘A 作用于当前目录快照，尚未加载的行无需提前请求，取消选择的项目从该快照排除。 [Apple 的选择操作说明](https://support.apple.com/guide/mac-help/select-items-mchlp1378/mac)
- 「前往」按 Navigation 和 Search 的模式组合 Dialog、FormControl 和 Autocomplete。目标验证复用文件元数据，候选通过已授权目录的分页列表获取。输入支持方向键、Tab、Enter 和 IME，菜单保留快捷键入口。 [Primer Autocomplete](https://primer.style/product/components/autocomplete/guidelines/) · [WAI-ARIA Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) · [Apple 的路径补全说明](https://support.apple.com/en-gb/guide/mac-help/-mchlp1236/mac)

## 文件写操作

- 按 Agent 0.4.7 的权限契约检查 Downloads、Documents、Desktop 的读写授权，保留 Library 的只读规则。移动同时校验源、目标根和项目版本。源项目版本发生变化时刷新列表并提示重新选择。 [API 契约](../docs/api.md#文件与目录)
- 右键和行尾菜单共享 ActionMenu 与 ActionList。菜单锚定指针或键盘焦点所在行，Shift+F10 和菜单键可打开，Escape 返回原焦点。不同权限只显示当前可用的操作。对应的文件信息和上传图标采用 Info 和 Upload Octicons。 [Primer ActionMenu](https://primer.style/product/components/action-menu/)
- 重命名、新建文件夹和上传统一使用 TextInput 的 `validationStatus` 与 FormControl.Validation。名称格式和已加载的同名项目即时提示。服务端确认底层卷的大小写规则以及隐藏或尚未分页的同名项目，冲突反馈显示在原输入框。 [Primer TextInput](https://primer.style/product/components/text-input/) · [Primer Forms](https://primer.style/product/ui-patterns/forms/)
- 上传先读取目标版本，再按连续偏移发送 256 KiB 分块。临时错误重试当前分块并沿用传输标识，保存前可取消暂存。覆盖需主动勾选并绑定当前版本，版本变化后重置确认。使用 ProgressBar 和状态文字显示进度，错误后保留选中的文件。 [传输契约](../docs/api.md#文件传输与-zip) · [Primer ProgressBar](https://primer.style/product/components/progress-bar/)

## 验收

- `npm --prefix web run build` 完成严格 TypeScript 检查与 Vite 生产构建。Vite 报告 Primer 的客户端指令和包体积提示。
- 十二条隔离 Chromium、ASP.NET Core 与 Swift Agent 0.4.7 浏览器验收通过。回归覆盖虚拟 Passkey、权限、隐藏项、排序、建目录、上传、改名、移动、下载、删除、PDF 预览、语言持久化、窄屏焦点和双设备授权。
- 写操作验收覆盖鼠标右键、键盘菜单和焦点返回、保留名称、UTF-8 字节上限、大小写冲突、仅修改大小写、源版本变化、移动同名保护、上传覆盖版本检查、临时 429 同偏移重试、保留本地选件、零字节文件和取消清理暂存。另有三条后端集成检查通过，覆盖范围写权限、移动与删除、续传与发布。
- 本轮新增场景确认列表和树合计只下载八个可见文件的八份原生 PNG。鼠标单击、⌘ 加选与取消、Shift 范围、按住拖动、空白清空和双击打开均通过。83 项目录首屏只加载 80 项时，⌘A 计数为 83，逐项取消的状态保留到分页完成。
- 路径对话框验证了快捷键打开和输入聚焦、Tab 补全、Enter 提交、相对与绝对路径、超过首个 200 项分段的候选、菜单入口、Escape 和共享范围外反馈。
- 本轮新增分页延迟回归，覆盖 320、375、768 和 1280 CSS px。滚动到底、等待加载和翻页完成后，文档高度始终等于窗口高度，标题栏、导航和路径栏坐标保持稳定。
- 420 × 1600 PNG 的列表缩略图宽高均在 20 px 内，等比显示于 36 px 文件行。浏览器读到原始文件的完整字节和原始尺寸。模拟传输失败时保留缩略图，重试和切换宽窄布局均通过。PDF 继续展示首页预览。
- 验证了标准和高对比度跟随系统亮暗并保存偏好。桌面分隔线可用鼠标与键盘操作，刷新后保留宽度。浏览器测得 28 px 列头、36 px 文件行、1 px 侧栏标题分隔线、选中栏从 0 展开到 65 px 再收起。已检查隔行颜色与按钮填充宽度。
- 83 项目录先显示 80 项，滚到底自动追加至 83 项。首屏只有一次列表和一次随后完成的轻量 stat。测试模拟带 `Retry-After` 的 429、设备超时和分页快照冲突，均自动恢复。外部新增文件通过目录订阅触发一次列表刷新。连续切换 12 个目录期间，设备读取并发上限为一，真实 Agent 未返回 429。
- 浏览器在 1280 × 950 下截图核对三个状态。顶栏分隔线与下方内容位于 y107–108，概要分隔线与下方内容位于 y236–237，路径栏分隔线位于 y909。原尺寸的目录页样本、字体渲染和实时文件内容存在差异。锁定、目录、行菜单、PDF 预览和窄屏截图保存在本机 `.local/frontend-check`。
- 窄屏检查覆盖 320、375 和 768 CSS px。375 px 下可从内容区打开目录树，页面无横向溢出。
- 对变更的 CSS 模块调用了 `primerdoc.lint_css`。服务对这些样式和此前只含两个官方变量的对照样式都返回「Errors without autofix remaining」，诊断正文为空。独立 PostCSS 检查成功解析全部九份 CSS 模块，并核对了四套主题下的 144 处变量引用。63 个手写前端文件均少于 200 行。
- 浏览器验收使用隔离 HOME 的权限样本和虚拟验证器。生产硬件 Passkey 与真实受保护目录上的 macOS 弹窗需另行实机核对。
- 当第二台设备上线时保留当前设备，直到操作者从菜单切换或当前设备从清单移除。此行为已纳入双设备验收。
- Alt 文本工具需要当前连接未启用的 sampling。人工核对使用空 alt 的装饰文件图标，以及使用实际文件名的内容预览。

## Data 页

- 采用 overview 模板。参考图为 2266 × 1316 图像像素，导航边界在 x≈560，右侧卡片从 x≈600 开始，同一行两卡宽约 802 图像像素，间距约 22，卡片高约 264。参考图的 DPR、缩放和裁切未知。实现沿用 File System 的 SplitPageLayout，在 176–480 CSS px 内调整侧栏，默认 272 CSS px。内容使用 24 CSS px 内距和 12 CSS px 卡片间距。内容容器小于 42 rem 时改为单列。小于 48 rem 时通过 Primer Dialog 打开同一 NavList，关闭后回到触发按钮。 [SplitPageLayout](https://primer.style/product/components/split-page-layout/) · [NavList](https://primer.style/product/components/nav-list/)
- 概览卡片使用安装版 Primer Card 的自定义内容模式、`Card.Link` 和原生焦点反馈。右上角显示时间与前往详情的箭头，卡片下方显示主值和真实采样。二维网格和柱状图使用 CSS Modules 与 SVG。图表按接收顺序展示至多九条采样，最后一条使用主题默认前景色。详情表格提供数值和时间。 [Primer Card](https://primer.style/product/components/card/) · [Data Visualization](https://primer.style/product/ui-patterns/data-visualization/)
- 首屏读取 `/status`、独立快照和有效策略，详情覆盖全部 17 个遥测主题及连接状态。应用清单支持搜索、滚动续载和详情。事件按类型筛选，通过最近 30 分钟历史补齐。两条 WebSocket 各自保持在 16 个订阅以内，按序号去重，重连后补齐。推送降级时轮询最新快照与可见历史。现有采样策略保留，已授权连接可以主动请求新样本。 [遥测结构](../docs/telemetry.md) · [WebSocket 协议](../docs/asyncapi.yaml)
- 隔离 Chromium、ASP.NET Core 和 Mac Agent 0.4.7 的五条 Data 浏览器检查通过，覆盖采样、推送、断线轮询与恢复、设备切换、离线快照、锁定、应用筛选和分页、事件详情、路径恢复和键盘操作。原有 12 条 File System 回归通过。1280 × 950 CSS px 检查两列同宽、12 px 间距及侧栏调整，另检查 768、375、320 CSS px 下的单列和窄屏导航。人工核对标准暗色、亮色和亮色高对比度。参考图尺寸证据只用于布局比例核对。
- Primer CSS 检查对两份 Data 模块返回空诊断。PostCSS 成功解析全部 11 份 CSS 模块，核对四套主题下 203 处变量引用，以及 88 个手写前端源文件的长度。

### Data 详情表格

- 主参考是当前 File Explorer 的实际 DOM。两处复用 ExplorerHeader、ExplorerTitle、ExplorerFacts、排序表头、CSS Modules、独立滚动区和续载观察器。正常桌面下标题栏高 129 px，表头 28 px，行高 36 px，偶数行使用 `bgColor-muted`。读取视图使用语义表格承载自己的列和内容，标题栏通过 Primer Select 切换数据集，行菜单通过 ActionMenu 打开同样样式的属性表格。
- Data 的导航和表格使用默认 Octicons 尺寸并继承 Primer 颜色。应用图标使用 Agent 的原生 PNG，在与 File Explorer 相同的 20 px 等比框内显示。仅可见行请求图标，沿用按设备串行的低优先级队列和内存缓存。应用变更通过 Agent 快照推送更新列表，当前过滤和排序由本地状态维护。 [应用图标接口](../docs/api.md#遥测诊断和审计)
- 与隔离 File Explorer 实测比对标题栏、表头、行高、字体和隔行底色。六条 Data 浏览器运行通过，其中五条覆盖全部读取类型、实时更新、离线恢复、移动端和键盘，另一次专门核对首屏至少 15 个原生 PNG 和同设备单请求并发。12 条 File System 回归通过。
- Primer CSS 工具对七份变更样式返回空诊断。PostCSS 验证全部 13 份 CSS 模块、四套主题下的 176 处变量引用，以及 96 个手写前端源文件的长度。

## Window Activity

- 2026-11-23 在同一 Primer 38.46.0 和 Primitives 11.10.0 基线上复用组件目录，复查 View、Navigation、Data Visualization、Loading、Empty States 和 Degraded Experiences。`#activity` 使用 overview 模板，保留顶栏 UnderlineNav 和 Versions 图标。面板标题用 Heading 和 Stack，多屏切换用带可见标签的 FormControl 和 medium Select。加载与错误复用 File System 的 Spinner 和重试组件。 [导航](https://primer.style/product/ui-patterns/navigation/) · [Select](https://primer.style/product/components/select/accessibility/)
- `Window Activity.svg` 的坐标系为 1280 × 950，外框从 (20, 128) 到 (1260, 930)，参考焦点边框为 4 个 SVG 单位，窗口圆角为 16。原始浏览器缩放未知。实现按需求使用 `base-size-20`、`base-size-16`、`borderWidth-thin` 和 `borderWidth-thicker`，配合 `bgColor-muted`、`borderColor-default`、`borderColor-accent-emphasis` 以及 `shadow-floating-small` 和 `shadow-floating-medium`。Primer 组件没有按设备屏幕几何排列的容器。CSS Modules 负责画布，位置、大小和比例作为设备数据传入 CSS 变量。容器查询按 80、44 和 48 CSS px 等效阈值收起空间不足的窗口文字。 [数据可视化](https://primer.style/product/ui-patterns/data-visualization/)
- `displays` 的像素宽高决定画布比例。窗口按逻辑坐标和 zIndex 投影，跨屏窗口由各显示器裁切。按 PID 对应 `apps-running` 的图标、版本和运行时长。授权连接订阅 `windows.changed`，失去 WebSocket 时用修订号长轮询。进入新设备连接、锁定或切页会停止原订阅和请求。 [窗口接口](../docs/api.md#窗口实时状态) · [显示器样本](../docs/telemetry.md)
- Chromium 与实际服务端及隔离测试 Agent 验证移动、缩放、焦点切换、图标、横竖屏、跨屏裁切、分辨率更新、授权撤销、长轮询和 WebSocket 恢复。WebKit 验证相同的画布比例、20 px 外距、16 px 圆角、4 px 焦点边框、真实 PNG 解码以及 204 长轮询后恢复推送。1280、768、375 和 320 CSS px 下页面无文档溢出。四套主题、简体中文和英文均实测，截图在 `.local/frontend-check/window-activity`。
- `primerdoc.lint_css` 对两个变更模块及仅含官方前景和背景变量的对照样式均返回错误，未给出诊断。PostCSS 成功解析两份样式，核对四套主题共 228 处变量引用。浏览器截图与 SVG 核对布局关系，窗口内容来自联调数据。
