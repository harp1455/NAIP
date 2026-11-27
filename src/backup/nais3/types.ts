/**
 * NAIS3 백업(.nais) 형식 — NAIS3 (© sunanakgo, GPL-3.0) src/main/backup/types.ts 를 옮겼다.
 *
 * .nais = ZIP:
 *   manifest.json        { format:'NAIS', formatVersion:1, app:'NAIS3', appVersion, createdAt, scope:'workspace', tables, tableCounts }
 *   checksums.json       { [경로]: { sha256, bytes } }
 *   data/settings.json   { mainParams: string | null }  (메인 화면 GenerationRequest JSON)
 *   data/tables/<표>.json 행 배열. BLOB·파일 열은 { "__asset": "assets/..." }
 *   assets/files/<표>/<id>.<확장자>   vibe_images·charref_images·library_images 의 file_path 원본
 *   assets/blobs/<표>/<id>-<열>.bin    thumbnail 등 BLOB
 * 생성 히스토리(images 표)는 들어 있지 않다.
 */

export const NAIS3_FORMAT_VERSION = 1 as const

export const NAIS3_TABLES = [
  'character_folders',
  'character_prompts',
  'fragment_folders',
  'fragments',
  'vibe_folders',
  'vibe_images',
  'charref_folders',
  'charref_images',
  'scene_presets',
  'gen_scenes',
  'prompt_presets',
  'library_stacks',
  'library_images'
] as const

export type Nais3Table = (typeof NAIS3_TABLES)[number]

export function isNais3Table(value: unknown): value is Nais3Table {
  return typeof value === 'string' && (NAIS3_TABLES as readonly string[]).includes(value)
}

/** 아직 읽지 않은 그림·BLOB (경로만) */
export interface Nais3AssetRef {
  __asset: string
}

export type Nais3Value = string | number | null | Nais3AssetRef
export type Nais3Row = Record<string, Nais3Value>

export interface Nais3Manifest {
  format: 'NAIS'
  formatVersion: typeof NAIS3_FORMAT_VERSION
  app: 'NAIS3'
  appVersion: string
  createdAt: string
  scope: 'workspace'
  tables: Nais3Table[]
  tableCounts: Partial<Record<Nais3Table, number>>
}

/** NAIS3 쪽 각 표의 열 (src/main/db/migrations.ts v1~v20 적용 후) — 내보낼 때 이 열만 쓴다 */
export const NAIS3_COLUMNS: Record<Nais3Table, readonly string[]> = {
  character_folders: ['id', 'name', 'sort_order', 'collapsed', 'color'],
  character_prompts: [
    'id', 'name', 'prompt', 'negative_prompt', 'folder', 'thumbnail', 'settings_json', 'sort_order',
    'created_at', 'updated_at', 'enabled', 'center_x', 'center_y', 'folder_id'
  ],
  fragment_folders: ['id', 'name', 'sort_order', 'collapsed', 'color'],
  fragments: ['id', 'name', 'content', 'folder', 'sort_order', 'created_at', 'updated_at', 'folder_id'],
  vibe_folders: ['id', 'name', 'sort_order', 'collapsed', 'color'],
  vibe_images: [
    'id', 'name', 'file_path', 'thumbnail', 'enabled', 'strength', 'info_extracted', 'encoded', 'encoded_ie',
    'folder_id', 'sort_order', 'created_at'
  ],
  charref_folders: ['id', 'name', 'sort_order', 'collapsed', 'color'],
  charref_images: [
    'id', 'name', 'file_path', 'thumbnail', 'enabled', 'ref_type', 'strength', 'fidelity', 'folder_id',
    'sort_order', 'created_at'
  ],
  scene_presets: ['id', 'name', 'sort_order', 'default_width', 'default_height', 'character_ids'],
  gen_scenes: [
    'id', 'name', 'prompt', 'negative_prompt', 'width', 'height', 'sort_order', 'created_at', 'updated_at',
    'preset_id', 'reserve_count', 'reserve_json'
  ],
  prompt_presets: ['id', 'name', 'prompt', 'negative_prompt', 'sort_order', 'params_json', 'prompt_parts_json'],
  library_stacks: ['id', 'name', 'created_at'],
  library_images: ['id', 'name', 'file_path', 'thumbnail', 'width', 'height', 'stack_id', 'created_at', 'sort_order']
}

export const NAIS3_FILE_TABLES = new Set<Nais3Table>(['vibe_images', 'charref_images', 'library_images'])
