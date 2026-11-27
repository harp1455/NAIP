/**
 * 에셋 제작 프로젝트 (캐릭터 챗용 이미지 대량 제작) 데이터 모델.
 *
 * 한 프로젝트 = 캐릭터 × 의상 × 표정 × 상황 … 의 조합(셀)마다 목표 장수를 정해 두고,
 * 생성 → 선별(채택/보류/탈락) → 일정한 이름·폴더로 내보내기까지를 관리한다.
 * 이 파일은 순수 타입과 기본값만 둔다 (화면·저장소·NovelAI 호출과 무관).
 */
import type { Params } from '../stores/prompt'
import type { ReferenceType } from '../nai/reference'

export type { Params as ProjectParams }

// ── 축 ────────────────────────────────────────────────────────────────────────

/** 축 종류 — 템플릿 변수({emotion}, {outfit} …)와 기본 프롬프트 위치를 정한다 */
export type AxisKind = 'character' | 'outfit' | 'expression' | 'situation' | 'location' | 'action' | 'custom'

/** 캐릭터 축의 고정 id (프로젝트 캐릭터 목록에서 자동으로 만들어진다) */
export const CHARACTER_AXIS = 'character'

export interface AxisValue {
  /** 조합 키에 들어가는 고정 id — 이름을 바꿔도 키가 바뀌지 않는다 */
  id: string
  /** 표시 이름 (예: 웃음) */
  label: string
  /** 파일 이름·코드에 쓸 이름 (비우면 label). 예: smile */
  slug?: string
  /** 프롬프트 조각 (예: smile, open mouth) */
  prompt: string
  /** 네거티브 조각 */
  negative?: string
  /**
   * 캐릭터별 프롬프트 (프로젝트 캐릭터 id → 조각). 있으면 그 캐릭터 조합에서는 prompt 대신 쓴다.
   * 예: 교복 — A는 "school uniform, red ribbon", B는 "school uniform, blue necktie"
   */
  perCharacter?: Record<string, string>
  /** false면 행렬에서 뺀다 (값을 지우지 않고 잠시 끄기) */
  enabled?: boolean
}

export interface Axis {
  id: string
  kind: AxisKind
  /** 표시 이름이자 템플릿 변수 이름 (예: 표정 → {표정}) */
  name: string
  /** 영문 템플릿 변수 이름 (예: hair → {hair}). 비우면 name만 쓴다 */
  key?: string
  /** 조각을 넣을 곳 — base: 메인 프롬프트, character: 캐릭터 프롬프트 (캐릭터가 없으면 메인으로) */
  target: 'base' | 'character'
  values: AxisValue[]
}

/** 축 종류별 기본 프롬프트 위치 — 캐릭터에 붙는 것(의상·표정·동작)은 캐릭터 프롬프트로 */
export const DEFAULT_AXIS_TARGET: Record<AxisKind, Axis['target']> = {
  character: 'character',
  outfit: 'character',
  expression: 'character',
  action: 'character',
  situation: 'base',
  location: 'base',
  custom: 'base'
}

export const AXIS_KIND_LABEL: Record<AxisKind, string> = {
  character: '캐릭터',
  outfit: '의상',
  expression: '표정',
  situation: '상황',
  location: '장소',
  action: '동작',
  custom: '사용자 정의'
}

// ── 캐릭터 ────────────────────────────────────────────────────────────────────

/** 프로젝트에 출연하는 캐릭터 — 캐릭터 라이브러리를 참조하고, 프로젝트 전용 설정을 덧붙인다 */
export interface ProjectCharacter {
  /** 프로젝트 안의 id (캐릭터 축 값 id로 쓰인다) */
  id: string
  /** 캐릭터 라이브러리(stores/characters)의 id. null = 라이브러리 없이 이 프로젝트에서만 쓰는 캐릭터 */
  libraryId: number | null
  /** 표시 이름 (라이브러리에서 지워져도 남도록 복사해 둔다) */
  name: string
  /** 파일 이름에 쓸 이름 (비우면 name) */
  slug?: string
  /** 이미지 코드 접두 (예: A → A001). 비우면 순서대로 A, B, C … */
  code?: string
  /** 이 캐릭터 조합에서 캐릭터 프롬프트 뒤에 덧붙일 조각 (라이브러리 프롬프트는 생성할 때 읽는다) */
  prompt?: string
  negative?: string
  /** 이 캐릭터 조합에만 쓸 바이브·정밀 레퍼런스 (stores/refs id) */
  vibeIds: number[]
  refIds: number[]
  /** false면 행렬에서 뺀다 */
  enabled?: boolean
}

// ── 제외 · 덮어쓰기 · 분류 규칙 ───────────────────────────────────────────────

/**
 * 제외 규칙 — when의 모든 축이 맞으면(축마다 나열한 값 중 하나) 그 조합을 만들지 않는다.
 * 예: { character: [B], outfit: [수영복] } → B의 수영복 조합 전부 제외
 */
export interface ExclusionRule {
  id: string
  when: Record<string, string[]>
  note?: string
}

/**
 * 조합별 덮어쓰기 — match(축 id → 값 id)에 맞는 조합에 적용한다. 모든 축을 지정하면 한 조합,
 * 일부만 지정하면 그 값을 가진 조합 전체. 프롬프트는 맞는 것을 모두 덧붙이고(덜 구체적인 것부터),
 * 숫자(해상도·장수·목표)는 가장 구체적인 것이(같으면 뒤에 있는 것이) 이긴다.
 */
export interface ComboOverride {
  id: string
  match: Record<string, string>
  prompt?: string
  negative?: string
  characterPrompt?: string
  width?: number
  height?: number
  /** 한 번에 생성할 장수 (전체 생성 계획) */
  count?: number
  /** 채택 목표 장수 */
  target?: number
}

/**
 * 분류 규칙 — 프로젝트 밖에서 만든 그림(히스토리)을 프롬프트 글자로 조합에 배정할 때 쓴다.
 * match는 쉼표로 나눈 단어가 모두 들어 있으면 일치 (히스토리 검색과 같은 방식)
 */
export interface ClassificationRule {
  id: string
  axisId: string
  valueId: string
  match: string
  field: 'prompt' | 'scene' | 'character' | 'any'
}

// ── 선별 · 에셋 상태 ─────────────────────────────────────────────────────────

export type CurationMark = 'unreviewed' | 'adopted' | 'hold' | 'rejected'

export const CURATION_LABEL: Record<CurationMark, string> = {
  unreviewed: '미선별',
  adopted: '채택',
  hold: '보류',
  rejected: '탈락'
}

/** 조합(에셋 항목)의 상태 */
export type AssetStatus = 'pending' | 'queued' | 'generating' | 'review' | 'adopted' | 'redo' | 'exported'

export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  pending: '미생성',
  queued: '생성 대기',
  generating: '생성 중',
  review: '선별 필요',
  adopted: '채택',
  redo: '재생성 필요',
  exported: '내보내기 완료'
}

/** 조합에 속한 그림 한 장 (원본·메타데이터는 히스토리에 있고 여기에는 선별 정보만) */
export interface AssetImage {
  /** 히스토리 이미지 id */
  id: number
  ts: number
  seed?: number
  width?: number
  height?: number
  mime?: string
  mark: CurationMark
  /**
   * 채택 칸 번호 (1부터). 채택하면 비어 있는 가장 작은 칸을 받고, 교체하면 새 그림이 같은 칸을 물려받는다 —
   * 그래서 이미지 코드·파일 이름이 교체 뒤에도 그대로다
   */
  slot?: number
  /** 같은 칸의 몇 번째 버전인지 (첫 채택 1, 교체할 때마다 +1) */
  version?: number
  /** 이 그림이 교체한 이전 채택 그림 id */
  replaces?: number
  /** 이 그림을 교체한 새 그림 id (교체되면 탈락으로 바뀐다) */
  supersededBy?: number
  /** 사용자 설명 (채팅 프롬프트용 목록의 {description}) */
  description?: string
  /** 마지막으로 내보낸 경로·시각·크기 */
  exported?: { path: string; at: number; bytes?: number }
}

/** 조합 하나 = 에셋 항목 하나 */
export interface AssetItem {
  key: string
  images: AssetImage[]
  /** 대표 이미지 (없으면 채택 중 첫 칸 → 보류 → 최신 순으로 고른다) */
  representative?: number
  /** 대기열에 들어가 아직 시작하지 않은 장수 / 지금 그리는 장수 (앱을 다시 열면 0으로 돌린다) */
  queued: number
  generating: number
  /** 생성 실패 장수 (다음 생성이 성공하면 줄어든다) */
  failed: number
  /** 사용자가 "재생성 필요"로 표시 */
  redo?: boolean
  /**
   * 채택 칸 번호 → 이미지 코드 (예: A001). 코드는 그림이 아니라 칸에 붙어서, 교체하거나
   * 채택을 풀었다 다시 채택해도 같은 칸이면 같은 코드다 (채팅 프롬프트의 코드가 깨지지 않게)
   */
  codes?: Record<string, string>
  /**
   * 채택 칸 번호 → 그 칸에서 마지막으로 내보낸 경로. 채택을 풀고 다른 그림을 채택해 같은 칸(같은 코드)을
   * 받으면 그 그림이 같은 파일을 새로 쓴다 (export.previousExportPath)
   */
  slotPaths?: Record<string, string>
  note?: string
}

// ── 내보내기 설정 ────────────────────────────────────────────────────────────

/** 번호({index})를 어디서부터 새로 셀지 */
export type IndexScope = 'global' | 'folder' | 'character' | 'combination'

/** 같은 경로가 겹칠 때 — suffix: 뒤에 _2 …, overwrite: 덮어쓰기, skip: 건너뛰기, error: 내보내기 막기 */
export type DuplicatePolicy = 'suffix' | 'overwrite' | 'skip' | 'error'

export interface NamingSettings {
  /** 파일 이름 템플릿 (확장자 제외). 예: {character}_{emotion}_{index:03} */
  fileTemplate: string
  /** 폴더 템플릿 ('/'로 단계 구분, nested일 때만). 예: {character}/{outfit} */
  folderTemplate: string
  /** flat: 모든 파일을 rootFolder 한 곳에, nested: folderTemplate으로 나눔 */
  folderMode: 'flat' | 'nested'
  /** 항상 맨 앞에 붙는 폴더 템플릿 (비우면 없음). 예: {project} */
  rootFolder: string
  /** 빈 변수 정리·중복 접미사·공백 대체에 쓰는 구분자 */
  separator: string
  /** 값 안의 공백을 separator로 바꾼다 */
  replaceSpaces: boolean
  startIndex: number
  indexScope: IndexScope
  duplicate: DuplicatePolicy
  /** 이름 한 단계(파일·폴더)의 최대 글자 수 (cleanFileName과 같은 80) */
  maxLength: number
  /** {custom} 값 */
  custom: string
}

export const DEFAULT_NAMING: NamingSettings = {
  fileTemplate: '{character}_{outfit}_{emotion}_{index:02}',
  folderTemplate: '{character}',
  folderMode: 'nested',
  rootFolder: '{project}',
  separator: '_',
  replaceSpaces: true,
  startIndex: 1,
  indexScope: 'combination',
  duplicate: 'suffix',
  maxLength: 80,
  custom: ''
}

export type ManifestFormat = 'csv' | 'json' | 'txt' | 'md'

export type ManifestColumn =
  | 'fileName'
  | 'path'
  | 'character'
  | 'scene'
  | 'expression'
  | 'outfit'
  | 'code'
  | 'resolution'
  | 'fileSize'
  | 'seed'
  | 'prompt'
  | 'description'

export interface ManifestSettings {
  format: ManifestFormat
  columns: ManifestColumn[]
  /** CSV 앞에 UTF-8 BOM (엑셀에서 한글이 깨지지 않게) */
  bom: boolean
  /** CSV에서 =,+,-,@로 시작하는 칸을 엑셀이 수식으로 읽지 않게 ' 를 붙인다 */
  guardFormulas: boolean
  /** {description}이 비었을 때 쓸 설명 템플릿 */
  descriptionTemplate: string
}

export const DEFAULT_MANIFEST: ManifestSettings = {
  format: 'csv',
  columns: ['code', 'fileName', 'path', 'character', 'outfit', 'expression', 'scene', 'resolution', 'seed'],
  bom: true,
  guardFormulas: false,
  descriptionTemplate: '{character} {outfit} {emotion}'
}

export interface CodeSettings {
  /** 이미지 코드 패턴. {char} = 캐릭터 코드(A, B …), {n} = 캐릭터 안 순번. 예: {char}{n:03} → A001 */
  pattern: string
  /** 채팅 프롬프트용 목록 한 줄 템플릿 */
  listTemplate: string
}

export const DEFAULT_CODES: CodeSettings = {
  pattern: '{char}{n:03}',
  listTemplate: '{code} | {character} | {emotion} | {file}'
}

/** 조합 폭발 경고 기준 (넘으면 경고만, hardLimit을 넘으면 펼치지 않는다) */
export interface PlanLimits {
  combos: number
  images: number
  anlas: number
  /** 예상 소요 시간(초) */
  seconds: number
  /** 이보다 많은 조합은 아예 펼치지 않는다 (화면이 멈추지 않게) */
  hardLimit: number
}

export const DEFAULT_LIMITS: PlanLimits = {
  combos: 200,
  images: 1000,
  anlas: 5000,
  seconds: 4 * 3600,
  hardLimit: 20000
}

// ── 프로젝트 ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  /** 파일 이름에 쓸 이름 (비우면 name) */
  slug?: string
  createdAt: number
  updatedAt: number
  characters: ProjectCharacter[]
  /** 공통 스타일·작가 프롬프트 */
  stylePrompt: string
  /** 공통 스타일을 메인 프롬프트 앞/뒤 어디에 둘지 */
  stylePosition: 'start' | 'end'
  /** 공통 네거티브 */
  negative: string
  /** 모델·해상도·샘플링 (프롬프트 화면과 같은 꼴) */
  params: Params
  /** 모든 조합에 쓸 바이브·정밀 레퍼런스 (stores/refs id) */
  vibeIds: number[]
  refIds: number[]
  /** 사용자 축 (캐릭터 축은 characters에서 자동으로 만든다) */
  axes: Axis[]
  exclusions: ExclusionRule[]
  overrides: ComboOverride[]
  rules: ClassificationRule[]
  /** 조합마다 기본 생성 장수 / 채택 목표 */
  defaults: { count: number; target: number }
  limits: PlanLimits
  naming: NamingSettings
  manifest: ManifestSettings
  codes: CodeSettings
  /** 내보낼 때 쓸 변환 프리셋 (없으면 원본 그대로) */
  convertPresetId: string | null
  /** 프리셋 없이 내보낼 때 NAI 메타데이터(PNG 글 청크·알파 숨은 정보)를 지운 PNG로 (기본 false = 원본 바이트 그대로) */
  exportStripMeta?: boolean
  /** 내보내기 번호 이어 매기기 — 번호 범위 열쇠 → 마지막으로 쓴 번호 (template.previewPaths의 counters) */
  exportCounters: Record<string, number>
  /** 조합 키 → 에셋 항목 (그림이 하나라도 있거나 상태가 있는 조합만) */
  items: Record<string, AssetItem>
}

/** 히스토리 이미지에 붙일 분류 표시 — 리드가 HistoryMeta에 `project` 같은 필드로 저장한다 */
export interface ProjectImageTag {
  projectId: string
  /** 조합 키 */
  key: string
  /** 축 id → 값 id (조합 키를 풀지 않고 바로 쓰도록) */
  coords: Record<string, string>
}

/** 비용 추정에 쓰는 레퍼런스 정보 (stores/refs의 CharRef와 같은 모양) */
export interface ReferenceInfo {
  id: number
  type: ReferenceType
  sameOutfit?: boolean
}

/** 사용자 정의 변환 프리셋 — 플랫폼 제한은 확인된 수치가 없어 기본값을 넣지 않는다 (presets.ts 참고) */
export interface PlatformPreset {
  id: string
  name: string
  format: 'png' | 'jpeg' | 'webp'
  maxWidth?: number
  maxHeight?: number
  /** 파일 하나의 최대 크기(바이트) */
  maxBytes?: number
  /** 0~1 (JPEG·WebP) */
  quality?: number
  /** 목표 크기를 맞출 때 내려갈 수 있는 품질 하한 */
  minQuality?: number
  /** JPEG로 바꿀 때 투명 부분을 채울 색 */
  background?: string
  note?: string
}
