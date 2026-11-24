import {useState, type ReactNode} from 'react'
import {Button, Stack} from '@primer/react'
import type {AlertDetail, AlertSummary} from '../api/alerts'
import {useLanguage} from '../i18n'
import {ExplorerFacts, ExplorerTitle} from '../ui/ExplorerHeader'
import {Timestamp} from '../ui/Timestamp'
import explorer from '../ui/explorer.module.css'
import {alertStatus} from './AlertHistory'
import styles from './alerts.module.css'

function ReplyValue({value, masked}: {value: string; masked?: boolean}) {
  const {t} = useLanguage()
  const [visible, setVisible] = useState(false)
  if (!value) return t('missing')
  return <Stack direction="horizontal" align="center" wrap="wrap" gap="condensed">
    <span className={styles.reply}>{masked && !visible ? '••••••' : value}</span>
    {masked && <Button variant="invisible" size="small" aria-pressed={visible} onClick={() => setVisible(!visible)}>
      {t(visible ? 'alertConceal' : 'alertReveal')}
    </Button>}
  </Stack>
}

function Replies({detail}: {detail: AlertDetail}) {
  const {t} = useLanguage()
  const {request, result} = detail
  const fields = request?.textFields ?? []
  const replies = result.textValues ? Object.entries(result.textValues).map(([id, value], index) => {
    const fieldIndex = fields.findIndex(item => item.id === id)
    const field = fields[fieldIndex]
    const number = (fieldIndex < 0 ? index : fieldIndex) + 1
    return {id, value, masked: field?.maskText ?? !request, label: field?.hintText || t('alertFieldNumber', {number})}
  }) : result.text == null ? [] : [{id: 'text', value: result.text, masked: request?.maskText ?? true, label: t('alertReply')}]
  if (!replies.length) return null
  return <dl className={`${styles.replies} ${explorer.metadata}`}>
    {replies.map(({id, label, value, masked}) => <div key={id} className={explorer.fact}>
      <dt>{label}</dt>
      <dd><ReplyValue value={value} masked={masked} /></dd>
    </div>)}
  </dl>
}

export function AlertInformation({item, detail, feedback, actions}: {
  item?: AlertSummary; detail?: AlertDetail; feedback?: ReactNode; actions: ReactNode
}) {
  const {t} = useLanguage()
  const sentAt = item?.createdAt
  const responseAt = detail?.result.respondedAt ?? item?.recordedAt
  const choiceId = detail?.result.choiceId
  const choice = detail?.request?.choices.find(item => item.id === choiceId)?.label ?? choiceId
  return <section className={styles.information} aria-label={t('alertInformation')}>
    <ExplorerTitle title={item ? item.title ?? detail?.request?.title ?? t('alertUnknownTitle') : t('alerts')} />
    {detail?.request?.message && <p className={styles.subtitle}>{detail.request.message}</p>}
    {item && <div className={styles.facts}>
      <ExplorerFacts items={[
        ['alertSent', <Timestamp value={sentAt} />],
        ['alertStatus', t(alertStatus[item.outcome])],
      ]} />
      <ExplorerFacts items={[["alertID", item.id]]} />
      <ExplorerFacts items={[["alertOption", choice ?? t('missing')]]} />
      {detail && <Replies key={item.id} detail={detail} />}
    </div>}
    {feedback}
    <div className={styles.detailFooter}>
      {item && <ExplorerFacts items={[
        ['alertTimeSend', <Timestamp value={sentAt} variant="exact" />],
        ['alertTimeResponse', <Timestamp value={responseAt} variant="exact" />],
      ]} />}
      <div className={styles.actions}>{actions}</div>
    </div>
  </section>
}
