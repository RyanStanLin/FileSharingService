import {Button, Link, Stack} from '@primer/react'
import {readDelivery} from '../api/notifications'
import {useLanguage} from '../i18n'
import {eventName} from '../notifications/notificationLabels'
import {settingsHref, subscriptionHref} from '../settings/settingsLocation'
import {ErrorText, Loading} from '../ui/Feedback'
import {useRefresh, useResource} from '../ui/async'
import {ReadingTable} from './ReadingTable'
import {deliveryValue} from './logDatasets'
import {objectDataset} from './readingModel'

export function DeliveryDetails({id}: {id: string}) {
  const {t, locale} = useLanguage()
  const delivery = useResource(id, signal => readDelivery(id, signal))
  const active = delivery.data && ['queued', 'sending', 'retryScheduled'].includes(delivery.data.state)
  useRefresh(!!active, delivery.refresh, 3000, false)
  if (!delivery.data) return delivery.error ? <Stack gap="condensed">
    <ErrorText error={delivery.error} />
    <div><Button size="medium" onClick={delivery.refresh}>{t('retry')}</Button></div>
  </Stack> : <Loading />
  const item = delivery.data
  const fields = objectDataset(item.id, eventName(item.event, locale), deliveryValue(item, t), locale, t)
  return <Stack gap="normal">
    <ErrorText error={delivery.error} />
    <ReadingTable nameTitle={fields.nameTitle} columns={fields.columns} rows={fields.rows} dialog />
    <Stack direction="horizontal" gap="normal" wrap="wrap">
      <Link href={settingsHref('channels', item.channelId)}>{t('notificationChannels')}</Link>
      {item.ruleId && <Link href={subscriptionHref(item.ruleId)}>{t('subscriptions')}</Link>}
    </Stack>
  </Stack>
}
