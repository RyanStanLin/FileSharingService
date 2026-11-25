import {useRef, useState} from 'react'
import {Button} from '@primer/react'
import {useLanguage} from '../i18n'
import {ErrorText} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useTask} from '../ui/async'

export function DeleteSetting({title, description, remove, disabled}: {
  title: string; description: string; remove: (signal: AbortSignal) => Promise<void>; disabled?: boolean
}) {
  const {t} = useLanguage()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const task = useTask()
  function close() { if (!task.busy) setOpen(false) }
  return <>
    <Button size="medium" variant="danger" ref={trigger} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>
      {title}
    </Button>
    {open && <Modal title={title} returnFocusRef={trigger} onClose={close} footerButtons={[
      {content: t('cancel'), size: 'medium', disabled: task.busy, onClick: close},
      {content: title, variant: 'danger', size: 'medium', loading: task.busy, onClick: () => void task.run(async signal => {
        await remove(signal)
        setOpen(false)
      })},
    ]}>
      <p>{description}</p><ErrorText error={task.error} />
    </Modal>}
  </>
}
