export const maintenanceEn = {
  maintenanceTitle: 'Maintenance mode',
  maintenanceKeywords: 'Agent restart, update, pause',
  maintenanceShort: 'Maintenance',
  maintenanceToggle: 'Pause automatic restart',
  maintenanceToggleHelp: 'The current Agent keeps running. If it exits, automatic restart waits until maintenance ends. The window lasts up to 10 minutes.',
  maintenanceStatus: 'Status',
  maintenanceInactive: 'Inactive',
  maintenancePreparing: 'Waiting for Mac confirmation',
  maintenanceActive: 'Active · Ready to update',
  maintenanceEnding: 'Ending maintenance',
  maintenanceEnded: 'Ended',
  maintenanceExpired: 'Expired',
  maintenanceRemaining: 'Maintenance time remaining',
  maintenanceExpiresAt: 'Automatic end time',
  maintenanceActiveOffline: 'The Mac is offline. You can still end the maintenance window.',
  maintenanceOffline: 'Connect this Mac to start maintenance.',
  maintenanceUpgrade: 'Update this Mac to Agent 0.5.12 or later to use maintenance mode.',
  maintenanceAuthorize: 'Authorize the current connection to start maintenance.',
}

export const maintenanceZh: Record<keyof typeof maintenanceEn, string> = {
  maintenanceTitle: '维护模式',
  maintenanceKeywords: '后台服务 重启 更新 暂停',
  maintenanceShort: '维护',
  maintenanceToggle: '暂停自动重启',
  maintenanceToggleHelp: '当前后台服务会继续运行。退出后，等维护结束再自动重启。维护窗口最长 10 分钟。',
  maintenanceStatus: '状态',
  maintenanceInactive: '未开启',
  maintenancePreparing: '等待 Mac 确认',
  maintenanceActive: '已开启，可以更新后台服务',
  maintenanceEnding: '正在结束维护',
  maintenanceEnded: '已结束',
  maintenanceExpired: '已到期',
  maintenanceRemaining: '维护剩余时间',
  maintenanceExpiresAt: '自动结束时间',
  maintenanceActiveOffline: 'Mac 已离线，仍可提前结束维护。',
  maintenanceOffline: 'Mac 上线后即可开启维护。',
  maintenanceUpgrade: '将此 Mac 的后台服务更新到 0.5.12 或以上版本，即可使用维护模式。',
  maintenanceAuthorize: '授权当前连接后即可开启维护。',
}

export const maintenanceErrorsEn = {
  maintenance_already_open: 'This Mac already has a maintenance window.',
  maintenance_agent_upgrade_required: maintenanceEn.maintenanceUpgrade,
  maintenance_lease_ended: 'The window ended before the Mac confirmed it.',
  maintenance_lease_not_found: 'This maintenance window has changed. Check its current status.',
  maintenance_receipt_invalid: 'The Mac could not confirm that it saved the maintenance window.',
}

export const maintenanceErrorsZh: Record<keyof typeof maintenanceErrorsEn, string> = {
  maintenance_already_open: '此 Mac 已有维护窗口。',
  maintenance_agent_upgrade_required: maintenanceZh.maintenanceUpgrade,
  maintenance_lease_ended: '维护窗口已在 Mac 确认前结束。',
  maintenance_lease_not_found: '维护窗口已更新，请查看当前状态。',
  maintenance_receipt_invalid: 'Mac 未能确认维护窗口已保存。',
}
