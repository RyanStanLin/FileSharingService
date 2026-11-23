export interface ModifierKeys {metaKey: boolean; ctrlKey: boolean}

const macOS = /Mac|iPad|iPhone/.test(navigator.platform)

export const primaryKeyHint = macOS ? '⌘' : 'Ctrl+'
export const primaryKeyName = macOS ? 'Meta' : 'Control'

export function primaryModifier(event: ModifierKeys) {
  return event.metaKey || (!macOS && event.ctrlKey)
}

export function explorerControl(target: Element) {
  return target.closest('button, input, textarea, select, [contenteditable], [role^="menuitem"], a:not([data-file-link])')
}
