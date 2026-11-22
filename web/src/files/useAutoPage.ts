import type {RefObject} from 'react'
import {useTableEnd} from '../ui/useTableEnd'
import type {DirectoryView} from './useDirectory'

export function useAutoPage(view: DirectoryView, scrollRoot?: RefObject<HTMLElement | null>) {
  const offset = view.page?.nextOffset
  const enabled = offset != null && !view.pending && !view.loadingMore && view.moreError == null
  return useTableEnd(enabled ? offset : undefined, () => void view.next(), scrollRoot)
}
