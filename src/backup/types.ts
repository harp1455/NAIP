/** NAIP 백업 형식(.naipbackup) 공용 타입 */

export const NAIP_FORMAT = 'NAIP'
export const NAIP_FORMAT_VERSION = 1
export const BACKUP_EXTENSION = '.naipbackup'
/**
 * 저장 대화상자에 넘기는 MIME. application/zip 으로 주면 일부 저장소가 이름 뒤에 .zip 을 덧붙여서
 * 확장자를 지키도록 octet-stream 을 쓴다.
 */
export const BACKUP_MIME = 'application/octet-stream'

/**
 * 백업 섹션. history·historyOriginals 를 뺀 나머지는 평범한 JSON 데이터(BackupData)로 오가고,
 * 히스토리는 양이 많아 포트(HistoryExportPort/HistoryImportPort)로 한 페이지·한 장씩 흐른다.
 */
export const SECTION_IDS = [
  'settings',
  'prompt',
  'presets',
  'characters',
  'scenes',
  'fragments',
  'vibes',
  'charRefs',
  'tagUsage',
  'masks',
  'saveFolders',
  'collections',
  'exportTemplates',
  'queue',
  'history',
  'historyOriginals'
] as const

export type SectionId = (typeof SECTION_IDS)[number]
export type DataSectionId = Exclude<SectionId, 'history' | 'historyOriginals'>
export type HistorySectionId = Extract<SectionId, 'history' | 'historyOriginals'>

export const DATA_SECTION_IDS = SECTION_IDS.filter(
  (id): id is DataSectionId => id !== 'history' && id !== 'historyOriginals'
)

export const SECTION_LABELS: Record<SectionId, string> = {
  settings: '앱 설정',
  prompt: '작업 중인 프롬프트',
  presets: '프롬프트 프리셋',
  characters: '캐릭터',
  scenes: '씬',
  fragments: '조각',
  vibes: '바이브',
  charRefs: '정밀 레퍼런스',
  tagUsage: '자주 쓴 태그',
  masks: '보관한 마스크',
  saveFolders: '저장 폴더·이름 번호',
  collections: '즐겨찾기·모음',
  exportTemplates: '내보내기 템플릿',
  queue: '생성 대기열',
  history: '히스토리 기록',
  historyOriginals: '히스토리 원본 그림'
}

export type BackupMode = 'light' | 'full' | 'custom'

/** light = 히스토리를 뺀 라이브러리·설정, full = 히스토리 원본까지 전부, custom = 고른 섹션만 */
export const MODE_SECTIONS: Record<Exclude<BackupMode, 'custom'>, readonly SectionId[]> = {
  light: DATA_SECTION_IDS,
  full: SECTION_IDS
}

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string' && (SECTION_IDS as readonly string[]).includes(value)
}

/** id 가 있는 항목 (캐릭터·프리셋·씬 …) — 나머지 필드는 그대로 통과한다 */
export interface BackupItem {
  id: number
  name?: string
  [key: string]: unknown
}

/**
 * 섹션별 데이터 모양 (현재 스토어의 persist 상태와 같다). 적힌 필드 밖의 것도 그대로 통과하므로
 * Phase 2 캐릭터 변형·슬롯처럼 나중에 생긴 필드도 백업·복원된다.
 * 복원할 때는 스토어에 setState(부분 병합)로 넣는 것을 전제로 한다.
 */
export interface SectionPayloads {
  /** 설정 스토어 (토큰·비밀값·서버에서 받은 구독 정보·저장 폴더 키 제외) */
  settings: Record<string, unknown>
  /** 작업 중인 프롬프트 — base/additional/detail/negative/params/seed/count/activePresetId */
  prompt: Record<string, unknown>
  presets: { presets: BackupItem[] } & Record<string, unknown>
  /** 불투명하게 다룬다: folders·characters·cast 외의 필드(변형·슬롯 등)도 통과 */
  characters: { folders?: BackupItem[]; characters?: BackupItem[]; cast?: unknown[] } & Record<string, unknown>
  scenes: { folders?: BackupItem[]; scenes?: BackupItem[] } & Record<string, unknown>
  fragments: { folders?: BackupItem[]; fragments?: BackupItem[] } & Record<string, unknown>
  /** image = 원본 PNG base64 (없으면 ''), encodings = `${model}|${ie}` → 인코딩 */
  vibes: { vibes: BackupItem[] } & Record<string, unknown>
  charRefs: { charRefs: BackupItem[] } & Record<string, unknown>
  tagUsage: { entries: Record<string, { n?: number; last?: number } & Record<string, unknown>> } & Record<string, unknown>
  masks: { masks: BackupItem[] } & Record<string, unknown>
  saveFolders: {
    saveFolders?: string[]
    saveFolder?: string
    nameMode?: string
    nameCounters?: Record<string, number>
  } & Record<string, unknown>
  collections: Record<string, unknown>
  exportTemplates: Record<string, unknown>
  queue: Record<string, unknown>
}

/** 백업에 담기는 JSON 데이터 전체 (섹션이 없으면 그 섹션은 백업·복원 대상이 아님) */
export type BackupData = { [K in DataSectionId]?: SectionPayloads[K] }

export interface NaipManifest {
  format: typeof NAIP_FORMAT
  formatVersion: number
  app: 'NAIP'
  appVersion: string
  createdAt: string
  mode: BackupMode
  sections: SectionId[]
  counts: Partial<Record<SectionId, number>>
}

export interface ChecksumEntry {
  sha256: string
  size: number
}

export type Checksums = Record<string, ChecksumEntry>

export type BackupErrorCode =
  | 'aborted'
  | 'not-zip'
  | 'zip-corrupt'
  | 'unsafe-path'
  | 'duplicate-entry'
  | 'too-many-entries'
  | 'entry-too-large'
  | 'total-too-large'
  | 'suspicious-ratio'
  | 'overlapping-entries'
  | 'encrypted'
  | 'unsupported-compression'
  | 'size-mismatch'
  | 'crc-mismatch'
  | 'checksum-mismatch'
  | 'missing-entry'
  | 'invalid-json'
  | 'invalid-manifest'
  | 'not-naip'
  | 'is-nais3'
  | 'unsupported-version'
  | 'write-failed'

export class BackupError extends Error {
  readonly code: BackupErrorCode
  /** 문제가 된 아카이브 안 경로 (있으면) */
  readonly path?: string
  constructor(code: BackupErrorCode, message: string, path?: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
    this.path = path
  }
}

/** 항목별 무결성 문제 — 체크섬 불일치 등은 예외로 끝내지 않고 모아서 보여 준다 */
export interface EntryProblem {
  path: string
  kind: 'checksum-mismatch' | 'missing' | 'unlisted' | 'corrupt' | 'invalid-json'
  detail: string
}

export interface ProgressInfo {
  phase: 'sections' | 'history' | 'originals' | 'finish' | 'verify' | 'restore'
  /** 처리한 항목 수 / 전체 (모르면 null) */
  done: number
  total: number | null
  /** 쓴(읽은) 바이트 */
  bytes: number
  current?: string
}

export type ProgressCallback = (p: ProgressInfo) => void

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupError('aborted', '취소했습니다')
}
