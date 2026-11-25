import {useRef, useState} from 'react'
import {Button, Link, Stack} from '@primer/react'
import {readDelivery, testChannel, verifyChannel} from '../api/notifications'
import type {NotificationChannel, NotificationDelivery} from '../api/notificationTypes'
import {useLanguage} from '../i18n'
import {SettingsRow, SettingsRows, SettingsText, SettingsTextarea} from '../settings/SettingsFields'
import {SettingsBand} from '../settings/SettingsPanel'
import {ErrorText} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useRefresh, useResource, useTask} from '../ui/async'
import {deliveryLabel, deliveryUrl} from './notificationLabels'

export function ChannelActions({channel, disabled}: {channel: NotificationChannel; disabled: boolean}) {
  const {t} = useLanguage()
  const [showTest, setShowTest] = useState(false)
  const [verified, setVerified] = useState<Awaited<ReturnType<typeof verifyChannel>>>()
  const trigger = useRef<HTMLButtonElement>(null)
  const task = useTask()

  return <SettingsBand>
    <SettingsRows>
      {channel.kind === 'telegram' && <SettingsRow title={t('notificationVerify')}
        description={verified && t('notificationVerified', {bot: verified.botUsername ? '@' + verified.botUsername : verified.botId,
          chat: verified.chatId, type: verified.chatType})}>
        <Button size="medium" loading={task.busy} disabled={disabled} onClick={() => void task.run(async signal => {
          setVerified(undefined)
          setVerified(await verifyChannel(channel.id, signal))
        })}>{t('notificationVerify')}</Button>
      </SettingsRow>}
      <SettingsRow title={t('notificationTest')} description={<Link href={deliveryUrl({channelId: channel.id})}>{t('notificationHistory')}</Link>}>
        <Button size="medium" ref={trigger} disabled={disabled || !channel.enabled} aria-haspopup="dialog"
          onClick={() => setShowTest(true)}>{t('notificationTest')}</Button>
      </SettingsRow>
    </SettingsRows>
    <ErrorText error={task.error} />
    {showTest && <ChannelTest channel={channel} trigger={trigger} close={() => setShowTest(false)} />}
  </SettingsBand>
}

function ChannelTest({channel, close, trigger}: {
  channel: NotificationChannel; close: () => void; trigger: React.RefObject<HTMLButtonElement | null>
}) {
  const {t} = useLanguage()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [result, setResult] = useState<NotificationDelivery>()
  const requestKey = useRef<{payload: string; key: string}>(undefined)
  const task = useTask()
  const delivery = useResource(result?.id ?? null, signal => readDelivery(result!.id, signal))
  const latest = delivery.data ?? result
  const pending = latest && ['queued', 'retryScheduled', 'sending'].includes(latest.state)
  useRefresh(!!pending, delivery.refresh, 2000, false)
  function dismiss() { if (!task.busy) close() }
  function send() {
    const input = {title: title.trim() || undefined, body: body.trim() || undefined}
    const payload = JSON.stringify(input)
    if (requestKey.current?.payload !== payload) requestKey.current = {payload, key: crypto.randomUUID()}
    const {key} = requestKey.current
    void task.run(async signal => { setResult(await testChannel(channel.id, key, input, signal)) })
  }

  return <Modal title={t('notificationTest')} subtitle={t('notificationTestHelp', {name: channel.name})}
    returnFocusRef={trigger} onClose={dismiss} footerButtons={[
      {content: t(latest ? 'close' : 'cancel'), size: 'medium', onClick: dismiss, disabled: task.busy},
      ...(!latest ? [{content: t('notificationTest'), size: 'medium' as const, variant: 'primary' as const, onClick: send, loading: task.busy}] : []),
    ]}>
    <Stack gap="normal">
      {latest ? <>
        <div role="status">{t(deliveryLabel[latest.state])}</div>
        <Link href={deliveryUrl({channelId: channel.id, delivery: latest.id})}>{t('notificationHistory')}</Link>
      </> : <>
        <SettingsText label={t('notificationMessageTitle')} value={title} maxLength={180} disabled={task.busy}
          onChange={event => setTitle(event.target.value)} />
        <SettingsTextarea rows={4} resize="vertical" label={t('notificationMessageBody')} value={body} maxLength={2800} disabled={task.busy}
          onChange={event => setBody(event.target.value)} />
      </>}
      <ErrorText error={task.error ?? delivery.error} />
    </Stack>
  </Modal>
}
