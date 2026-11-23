const activity = {
  activityTitle: ['Live Activity', '实时活动'],
  activityAuthorize: ['Authorize the current connection to {device} to view its windows.', '授权 {device} 的当前连接以查看窗口。'],
  activityLoading: ['Waiting for the window layout…', '正在读取窗口布局…'],
  activityUnavailable: ['Window activity is unavailable', '暂时无法读取窗口活动'],
  activityUnsupported: ['Window Activity requires Mac Agent 0.4.8 or later.', '窗口活动需要 Mac Agent 0.4.8 或更新版本。'],
  activityResume: ['Reconnecting', '正在重连'],
  activityNoDisplay: ['No active displays', '没有活动显示器'],
  activityEmpty: ['No windows on this display', '此显示器上没有窗口'],
  activityForeground: ['Foreground: {name}', '前台应用：{name}'],
  activityNoForeground: ['No foreground window', '没有前台窗口'],
  activityMainDisplay: ['Main display', '主显示器'],
  activityDisplay: ['Display {number}', '显示器 {number}'],
  activityDisplayName: ['Display', '显示器'],
  activityScreenLabel: ['Windows on {display}', '{display}上的窗口'],
  activityResolution: ['{width} × {height} px', '{width} × {height} 像素'],
  activityDisplayOption: ['{display} · {resolution}', '{display} · {resolution}'],
  activityWindowName: ['Window {id}', '窗口 {id}'],
  activityFocused: ['{name}, focused window', '{name}，焦点窗口'],
  activityTruncated: ['Partial window layout', '仅显示部分窗口'],
} as const

type Messages = Record<keyof typeof activity, string>

export const activityEn = Object.fromEntries(Object.entries(activity).map(([key, message]) => [key, message[0]])) as Messages
export const activityZh = Object.fromEntries(Object.entries(activity).map(([key, message]) => [key, message[1]])) as Messages
