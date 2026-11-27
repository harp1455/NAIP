/**
 * 히스토리 저장소의 얇은 SQL 계층. 휴대폰은 네이티브 SQLite(NaipStoragePlugin.java),
 * 브라우저 개발 빌드와 테스트는 sql.js(WASM)가 같은 SQL을 실행한다.
 *
 * 두 쪽 모두에서 돌아야 하므로 SQL은 Android 10(SQLite 3.22)이 아는 문법만 쓴다:
 * UPSERT(ON CONFLICT … DO UPDATE)·RETURNING·윈도 함수·JSON 함수·FTS5는 쓰지 않는다.
 * 바인딩 변수는 한 문장에 999개를 넘기지 않는다 (Android 기본 한도) — IN 목록은 chunk()로 나눈다.
 */
export type SqlValue = number | string | null

export interface SqlStatement {
  sql: string
  params?: SqlValue[]
}

export interface ExecResult {
  /** 바뀐 행 수 */
  changes: number
}

export interface SqlDriver {
  /** 행을 돌려주지 않는 문장 하나 */
  exec(sql: string, params?: SqlValue[]): Promise<ExecResult>
  /** SELECT — 열 이름을 키로 한 객체 배열 */
  query<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>
  /** 여러 문장을 한 트랜잭션으로 (하나라도 실패하면 모두 되돌린다) */
  batch(statements: SqlStatement[]): Promise<void>
  /** 드라이버 종류 (진단 표시용) */
  readonly kind: 'native' | 'sqljs'
}

/** Android SQLite의 바인딩 변수 한도(999) 아래로 나눈다 */
export function chunk<T>(list: T[], size = 400): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** `?, ?, ?` */
export function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}
