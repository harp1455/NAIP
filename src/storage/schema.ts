import type { SqlDriver } from './driver'

/**
 * 버전드 스키마 (NAIS3 src/main/db/migrations.ts의 규칙을 따른다 — © sunanakgo, GPL-3.0):
 * - 배열 인덱스+1 = 적용 후 user_version.
 * - 이미 배포된 항목은 고치지 않는다. 바꿀 것이 생기면 항상 새 항목을 덧붙인다.
 * - 각 항목은 user_version 변경과 함께 한 트랜잭션으로 적용된다 — 중간에 앱이 죽어도 반쯤 바뀐 DB가 남지 않는다.
 * Android 10의 SQLite(3.22)에서도 돌아야 하므로 UPSERT·RETURNING·JSON 함수·FTS5는 쓰지 않는다.
 */
export const MIGRATIONS: string[][] = [
  // v1: 히스토리 (원본·썸네일은 파일, DB에는 경로와 메타데이터만)
  [
    `CREATE TABLE images (
      id INTEGER PRIMARY KEY,          -- uid(): ms 타임스탬프 기반, 최신순 정렬 키
      ts INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      seed INTEGER NOT NULL,
      model TEXT NOT NULL,
      kind TEXT NOT NULL,              -- t2i | i2i | inpaint | director | upscale
      prompt TEXT NOT NULL,
      negative TEXT NOT NULL,
      mime TEXT NOT NULL,
      file TEXT,                       -- 원본 상대 경로 (images/<id>.png). 원본이 없던 옛 기록은 NULL
      bytes INTEGER NOT NULL DEFAULT 0,-- 원본 크기 (옮기기 검증·저장 공간 점검용)
      thumb TEXT,                      -- 썸네일 상대 경로 (thumbs/<id>.jpg|webp). 없으면 화면이 다시 만든다
      scene_id INTEGER,
      scene_name TEXT,
      fav INTEGER NOT NULL DEFAULT 0,
      unsaved INTEGER NOT NULL DEFAULT 1,
      saved TEXT,                      -- 갤러리에 마지막으로 저장한 Pictures/NAIP 아래 경로
      parent_id INTEGER,               -- i2i·인페인트 원본 (편집 계보)
      req_id TEXT,                     -- 생성 요청 id — 앱이 죽은 뒤 "보낸 요청이 결과를 남겼는지" 확인용
      snap TEXT,                       -- SettingsSnapshot JSON
      sent TEXT,                       -- 실제로 보낸 내용 JSON
      extra TEXT                       -- HistoryMeta의 그 밖의 필드 JSON (나중에 늘어난 필드를 잃지 않게)
    )`,
    'CREATE INDEX idx_images_fav ON images(fav, id)',
    'CREATE INDEX idx_images_unsaved ON images(unsaved, id)',
    'CREATE INDEX idx_images_scene ON images(scene_id, id)',
    'CREATE INDEX idx_images_model ON images(model, id)',
    'CREATE INDEX idx_images_kind ON images(kind, id)',
    'CREATE INDEX idx_images_parent ON images(parent_id)',
    'CREATE INDEX idx_images_ts ON images(ts)',
    'CREATE INDEX idx_images_req ON images(req_id)',
    // 검색용 소문자 글 — 큰 JSON이 든 images를 훑지 않도록 좁은 표로 따로 둔다.
    // FTS는 쓰지 않는다: 지금의 "부분 문자열" 검색(예: "blue ey")과 결과가 달라지고, FTS5는 Android에 없을 수 있다
    'CREATE TABLE image_text (id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
    // 앱 상태 (옮기기 진행 등)
    'CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    // 생성 대기열 — 배치 내용(JSON 파일)은 누를 때 한 번만 쓰고, 장마다의 진행은 작은 행으로 따로 쓴다.
    // 배치에는 i2i 원본·레퍼런스 그림(base64)이 들어 수 MB가 될 수 있어 DB 행이 아니라 파일에 둔다
    // (Android 커서 창 2MB를 넘는 행은 읽을 수 없다)
    `CREATE TABLE queue_batches (
      id INTEGER PRIMARY KEY,          -- Batch.id (uid, 만든 순서 = 도는 순서)
      label TEXT NOT NULL,
      file TEXT NOT NULL,              -- queue/<id>.json — Batch JSON (조각 치환 함수 대신 조각 라이브러리 사본)
      created INTEGER NOT NULL
    )`,
    `CREATE TABLE queue_items (
      batch_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,            -- 배치 계획(plan)에서의 원래 위치
      state TEXT NOT NULL,             -- sending(보냈고 결과 전) | done | failed | skipped
      req_id TEXT NOT NULL,
      image_id INTEGER,
      seed INTEGER,
      updated INTEGER NOT NULL,
      PRIMARY KEY (batch_id, idx)
    )`
  ]
]

export async function userVersion(driver: SqlDriver): Promise<number> {
  const [row] = await driver.query<{ user_version: number }>('PRAGMA user_version')
  return Number(row?.user_version ?? 0)
}

/** 남은 스키마 변경을 적용한다 */
export async function migrate(driver: SqlDriver): Promise<number> {
  let v = await userVersion(driver)
  if (v > MIGRATIONS.length) {
    throw new Error(`저장소 버전(${v})이 이 앱(${MIGRATIONS.length})보다 새롭습니다. 앱을 최신 버전으로 업데이트하세요.`)
  }
  while (v < MIGRATIONS.length) {
    await driver.batch([...MIGRATIONS[v].map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${v + 1}` }])
    v++
  }
  return v
}
