import {ApiError} from '../api/client'
import {stat} from '../api/files'
import type {Location} from '../api/types'
import type {Message} from '../i18n'
import {join} from './navigation'

const encoder = new TextEncoder()
const protectedSuffixes = new Set(['app', 'pkg', 'kext', 'bundle', 'plugin', 'dylib', 'framework', 'command'])
const reservedNames = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.config', '.npmrc', '.netrc', '.git-credentials',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zsh_history', '.bashrc', '.bash_history',
  '.profile', '.bash_profile', '.trash', '.local', '.docker', '.password-store', '.cursor',
  '.codex', '.agents', '.gemini', '.claude', '.cache', '.git',
])

export function fileNameIssue(directory: string, name: string): Message | undefined {
  if (!name) return 'nameRequired'
  if (name === '.' || name === '..' || /[/\\\p{Cc}\p{Cf}]/u.test(name)) return 'nameCharacters'
  const normalized = name.toLowerCase()
  if (normalized.startsWith('.filesharing-') || normalized.startsWith('.env') || reservedNames.has(normalized)) return 'nameReserved'
  if (encoder.encode(name).byteLength > 255) return 'nameTooLong'
  const path = join(directory, name)
  if (path.length > 3000 || path.split('/').length > 40) return 'namePathTooLong'
  const suffix = normalized.split('.').filter(Boolean).at(-1)
  if (suffix && protectedSuffixes.has(suffix)) return 'nameTypeBlocked'
}

export function isNameFault(error: unknown) {
  return error instanceof ApiError && ['invalid_file_name', 'entry_path_required', 'invalid_path', 'already_exists'].includes(error.code)
}

export function isStaleEntry(error: unknown) {
  return error instanceof ApiError && ['version_mismatch', 'not_found', 'delete_incomplete'].includes(error.code)
}

export function isVersionMismatch(error: unknown) {
  return error instanceof ApiError && error.code === 'version_mismatch'
}

export async function findUploadTarget(device: string, folder: Location, name: string, signal: AbortSignal) {
  try {
    return await stat(device, {...folder, path: join(folder.path, name)}, signal)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') return undefined
    throw error
  }
}
