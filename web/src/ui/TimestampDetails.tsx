import {useState} from 'react'
import {Link} from '@primer/react'
import {useLanguage, type Message} from '../i18n'
import {Modal} from './Modal'
import {Timestamp, timestampEpoch} from './Timestamp'

export function TimestampDetails({value, label}: {value?: string | null; label: Message}) {
  const {t} = useLanguage()
  const [selected, setSelected] = useState<string>()
  const close = () => setSelected(undefined)
  const available = value && timestampEpoch(value) !== undefined
  return <>
    {available ? <Link as="button" type="button" aria-haspopup="dialog" onClick={() => setSelected(value)}>
      <Timestamp value={value} />
    </Link> : t('missing')}
    {selected && <Modal title={t(label)} onClose={close}
      footerButtons={[{size: 'medium', content: t('close'), onClick: close}]}>
      <Timestamp value={selected} variant="exact" />
    </Modal>}
  </>
}
