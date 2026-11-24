import {useRef, useState} from 'react'
import {ActionList, ActionMenu, IconButton} from '@primer/react'
import {DownloadIcon, KebabHorizontalIcon, TrashIcon} from '@primer/octicons-react'
import {deleteTerminal, terminalDownload, type TerminalSession} from '../api/terminals'
import {useLanguage} from '../i18n'
import {useTask} from '../ui/async'
import {ErrorText} from '../ui/Feedback'
import {Modal} from '../ui/Modal'

export function TerminalSessionActions({session, remove}: {session: TerminalSession; remove: () => void}) {
  const {t} = useLanguage()
  const [confirm, setConfirm] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const task = useTask()

  return <>
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton ref={anchor} icon={KebabHorizontalIcon} size="medium" aria-label={t('terminalActions')} />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay align="end">
        <ActionList>
          <ActionList.LinkItem href={terminalDownload(session)} download={`terminal-${session.id}.ndjson`}>
            <ActionList.LeadingVisual><DownloadIcon /></ActionList.LeadingVisual>{t('terminalDownload')}
          </ActionList.LinkItem>
          {session.state === 'terminated' && <ActionList.Item variant="danger" onSelect={() => setConfirm(true)}>
            <ActionList.LeadingVisual><TrashIcon /></ActionList.LeadingVisual>{t('terminalDelete')}
          </ActionList.Item>}
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
    {confirm && <Modal title={t('terminalDelete')} role="alertdialog" returnFocusRef={anchor}
      onClose={() => { if (!task.busy) setConfirm(false) }} footerButtons={[
        {size: 'medium', content: t('cancel'), onClick: () => setConfirm(false), disabled: task.busy, autoFocus: true},
        {size: 'medium', content: t('terminalDelete'), buttonType: 'danger', loading: task.busy, onClick: () => {
          void task.run(async signal => {
            await deleteTerminal(session, signal)
            if (!signal.aborted) { setConfirm(false); remove() }
          })
        }},
      ]}>
      <p>{t('terminalDeleteHelp')}</p><ErrorText error={task.error} />
    </Modal>}
  </>
}
