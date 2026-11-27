/**
 * 히스토리 포트 — 히스토리 저장소(Phase 3: 네이티브 SQLite + 파일)와 백업 사이의 경계.
 * 기록(meta)은 불투명한 JSON 으로 다루고 id(숫자)와 mime 만 본다. 원본은 한 장씩만 메모리에 올린다.
 */

/** 히스토리 기록 한 건 (썸네일·프롬프트·즐겨찾기 등 나머지 필드는 그대로 통과) */
export interface HistoryRecord {
  id: number
  mime?: string
  [key: string]: unknown
}

export interface HistoryExportPort {
  /** 장수와 (알면) 원본·기록 바이트 수 — 예상 크기·진행률용 */
  stats(): Promise<{ count: number; originalBytes?: number | null; metaBytes?: number | null }>
  /** 기록을 페이지 단위로 (순서는 자유, 보통 오래된 것부터) */
  pages(pageSize: number): AsyncIterable<HistoryRecord[]>
  /** 원본 바이트. 파일이 사라졌으면 null (백업은 기록만 남기고 건너뛴 것으로 센다) */
  original(record: HistoryRecord): Promise<Uint8Array | null>
}

export interface HistoryImportPort {
  /** 이 id 들 중 이미 있는 것 */
  existingIds(ids: number[]): Promise<Set<number>>
  /** 덮어쓰기 복원 전에 전부 비운다 */
  clear(): Promise<void>
  /** 기록 하나와 원본(없으면 null)을 넣는다 */
  put(record: HistoryRecord, original: Uint8Array | null): Promise<void>
}

/** 백업 안의 기록 한 줄 */
export interface HistoryLine {
  record: HistoryRecord
  /** 원본 항목 경로 (원본 없이 기록만 담았으면 null) */
  original: string | null
}

export type HistoryRestoreMode = 'replace' | 'merge'

export interface HistoryRestoreResult {
  added: number
  /** 이미 있어서 건너뛴 기록 (병합) */
  skippedExisting: number
  /** 원본이 없거나 손상돼 기록만 넣은 것 */
  missingOriginals: number
  /** 손상돼 아예 못 넣은 기록 */
  failed: number
}
