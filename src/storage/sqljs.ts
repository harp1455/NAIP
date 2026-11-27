import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import type { ExecResult, SqlDriver, SqlStatement, SqlValue } from './driver'

/** DB 파일 전체를 어딘가(브라우저는 IndexedDB)에 보관하는 방법 */
export interface SqlJsPersistence {
  load(): Promise<Uint8Array | null>
  save(bytes: Uint8Array): Promise<void>
}

let sqlPromise: Promise<SqlJsStatic> | null = null

function loadSql(locateFile?: (file: string) => string): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs(locateFile ? { locateFile } : undefined)
  return sqlPromise
}

/**
 * sql.js 드라이버 — 브라우저 개발 빌드와 테스트용. 쓰기가 끝날 때마다 DB 전체를 내보내 보관한다
 * (진행 중인 보관이 있으면 끝난 뒤 한 번 더 — 쓰기가 몰려도 마지막 상태가 반드시 남는다).
 */
export async function createSqlJsDriver(opts: {
  persistence?: SqlJsPersistence
  locateFile?: (file: string) => string
} = {}): Promise<SqlDriver & { flush(): Promise<void>; db: Database }> {
  const SQL = await loadSql(opts.locateFile)
  const saved = opts.persistence ? await opts.persistence.load() : null
  const db = saved ? new SQL.Database(saved) : new SQL.Database()

  let dirty = false
  let saving: Promise<void> | null = null
  const persist = (): Promise<void> => {
    if (!opts.persistence) return Promise.resolve()
    dirty = true
    if (saving) return saving.then(() => (dirty ? persist() : undefined))
    saving = (async () => {
      // 지금까지의 변경을 한 번에 — 내보내는 사이에 새로 바뀐 것은 다음 차례에 남긴다
      while (dirty) {
        dirty = false
        await opts.persistence!.save(db.export())
      }
    })().finally(() => {
      saving = null
    })
    return saving
  }
  if (opts.persistence && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && dirty) void persist()
    })
  }

  const run = (sql: string, params?: SqlValue[]): number => {
    db.run(sql, params ?? [])
    return db.getRowsModified()
  }

  return {
    kind: 'sqljs',
    db,
    async exec(sql, params): Promise<ExecResult> {
      const changes = run(sql, params)
      void persist()
      return { changes }
    },
    async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
      const stmt = db.prepare(sql)
      try {
        stmt.bind(params ?? [])
        const out: T[] = []
        while (stmt.step()) out.push(stmt.getAsObject() as T)
        return out
      } finally {
        stmt.free()
      }
    },
    async batch(statements: SqlStatement[]): Promise<void> {
      if (!statements.length) return
      db.run('BEGIN')
      try {
        for (const s of statements) db.run(s.sql, s.params ?? [])
        db.run('COMMIT')
      } catch (e) {
        db.run('ROLLBACK')
        throw e
      }
      void persist()
    },
    flush: () => (dirty || saving ? persist() : Promise.resolve())
  }
}

/** 브라우저: DB 파일을 IndexedDB 한 칸에 통째로 보관한다 */
export function idbPersistence(dbName = 'naip-sql'): SqlJsPersistence {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('db')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  let dbp: Promise<IDBDatabase> | null = null
  return {
    async load() {
      dbp ??= open()
      const idb = await dbp
      return new Promise((resolve, reject) => {
        const req = idb.transaction('db').objectStore('db').get('main')
        req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null)
        req.onerror = () => reject(req.error)
      })
    },
    async save(bytes) {
      dbp ??= open()
      const idb = await dbp
      await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction('db', 'readwrite')
        tx.objectStore('db').put(bytes, 'main')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    }
  }
}
