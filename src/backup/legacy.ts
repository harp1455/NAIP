/** 예전 NAIP JSON 백업(설정 탭 "내보내기", app:'naip' version:2) → BackupData (새 복원 흐름으로 열 수 있게) */
import { stripCredentials } from './credentials'
import { BackupError, type BackupData } from './types'

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function isLegacyNaipJson(v: unknown): boolean {
  return isObj(v) && v.app === 'naip' && isObj(v.prompt)
}

export function fromLegacyNaipJson(raw: unknown): BackupData {
  if (!isLegacyNaipJson(raw)) throw new BackupError('not-naip', 'NAIP 백업 파일이 아닙니다')
  const v = stripCredentials(raw as Record<string, unknown>).value
  if (typeof v.version === 'number' && v.version > 2) {
    throw new BackupError('unsupported-version', `더 새로운 NAIP JSON 백업(버전 ${v.version})입니다 — 앱을 업데이트하세요`)
  }
  const data: BackupData = {}
  const prompt = v.prompt as Record<string, unknown>
  const { presets, ...current } = prompt
  data.prompt = current
  if (Array.isArray(presets)) data.presets = { presets: presets as never }
  if (isObj(v.characters)) data.characters = v.characters
  if (isObj(v.fragments)) data.fragments = v.fragments
  if (isObj(v.scenes)) data.scenes = v.scenes
  return data
}
