import type {ChannelInput, NotificationChannel} from '../api/notificationTypes'

const barkDefault = 'https://api.day.app'

export function channelDraft(channel?: NotificationChannel) {
  return {
    name: channel?.name ?? '',
    kind: channel?.kind ?? 'bark' as const,
    enabled: channel?.enabled ?? true,
    credential: '',
    server: channel?.bark?.server ?? barkDefault,
    group: channel?.bark?.group ?? '',
    sound: channel?.bark?.sound ?? '',
    level: channel?.bark?.level ?? '',
    chatId: channel?.telegram?.chatId ?? '',
    thread: channel?.telegram?.messageThreadId?.toString() ?? '',
    silent: channel?.telegram?.silent ?? false,
  }
}

export type ChannelDraft = ReturnType<typeof channelDraft>

function httpsOrigin(value: string) {
  try { return new URL(value) } catch { return undefined }
}

export function channelErrors(draft: ChannelDraft, base?: NotificationChannel) {
  const errors: Record<string, string> = {}
  if (draft.kind === 'bark') {
    const text = draft.server.trim() || barkDefault
    const origin = httpsOrigin(text)
    if (!origin || !['https:', 'http:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
      errors.server = 'invalid_bark_origin'
    }
    if ((!base || origin?.origin !== base.bark?.server) && !draft.credential) errors.credential = 'notification_credential_required'
    else if (draft.credential && !/^[A-Za-z0-9_-]{1,128}$/.test(draft.credential.trim())) errors.credential = 'invalid_bark_key'
  } else {
    const chatId = draft.chatId.trim()
    const id = Number(chatId)
    if (!/^@[A-Za-z0-9_-]{1,64}$/.test(chatId) &&
      (!/^-?[1-9]\d*$/.test(chatId) || Math.abs(id) >= 2 ** 52)) errors.chatId = 'invalid_telegram_chat'
    if (draft.thread && (!/^\d+$/.test(draft.thread) || Number(draft.thread) < 1 || Number(draft.thread) > 2147483647)) {
      errors.thread = 'invalid_telegram_thread'
    }
    if (!base && !draft.credential) errors.credential = 'notification_credential_required'
    else if (draft.credential && !/^\d{1,20}:[A-Za-z0-9_-]{10,147}$/.test(draft.credential.trim())) {
      errors.credential = 'invalid_telegram_bot_token'
    }
  }
  return errors
}

export function channelInput(draft: ChannelDraft, base?: NotificationChannel): ChannelInput {
  const name = draft.name.trim()
  const secret = draft.credential.trim() || undefined
  const common = {name, kind: draft.kind, enabled: draft.enabled, revision: base?.revision}
  return draft.kind === 'bark' ? {...common, bark: {
    server: draft.server.trim() || undefined,
    deviceKey: secret,
    group: draft.group.trim() || undefined,
    sound: draft.sound.trim() || undefined,
    level: draft.level || undefined,
  }} : {...common, telegram: {
    chatId: draft.chatId.trim(),
    botToken: secret,
    messageThreadId: draft.thread ? Number(draft.thread) : undefined,
    silent: draft.silent,
  }}
}
