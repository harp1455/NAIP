/**
 * 자격 증명 제거 — 백업에는 NovelAI 토큰·GitHub 토큰 같은 비밀값이 절대 들어가지 않는다.
 * 쓸 때와 읽을 때 모두 거친다 (조작된 백업이 복원하면서 토큰을 덮어쓰지 못하게).
 *
 * - 키 이름: token, githubToken, access_token, apiKey, secret, clientSecret, password, passwd,
 *   passphrase, authorization, credential(s), cookie(s) — 대소문자 무시, 이 단어로 끝나는 키는 제거
 * - 값 모양: NovelAI 영구 토큰(pst-…), GitHub 토큰(ghp_… / github_pat_…), Bearer … 은 키 이름과 상관없이 비운다
 * - 사용자 데이터가 키인 맵(태그 사용 기록·이름 번호·바이브 인코딩 등)의 키는 필드 이름이 아니므로
 *   키 이름 규칙에서 빼고 값만 검사한다 (예: "secret" 이라는 태그 기록을 지우지 않도록)
 */

const SECRET_KEY = /(?:token|secrets?|password|passwd|passphrase|api[_-]?key|authorization|credentials?|cookies?)$/i
const SECRET_VALUE = /^(?:pst-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+\S{16,})$/

/** 이 이름의 객체 아래 키들은 데이터 키(태그 이름 등)라서 키 이름 규칙을 적용하지 않는다 */
export const DATA_KEYED_MAPS = new Set(['entries', 'nameCounters', 'castCenters', 'encodings', 'reserves', 'counts'])

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

export function isSecretValue(value: string): boolean {
  return SECRET_VALUE.test(value.trim())
}

export interface StripResult<T> {
  value: T
  /** 지운 위치 (예: settings.token) — 테스트·로그용, 값은 담지 않는다 */
  removed: string[]
}

export function stripCredentials<T>(value: T, rootPath = ''): StripResult<T> {
  const removed: string[] = []
  const walk = (v: unknown, path: string, dataKeys: boolean): unknown => {
    if (typeof v === 'string') {
      if (isSecretValue(v)) {
        removed.push(path)
        return ''
      }
      return v
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, false))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k
        if (!dataKeys && isSecretKey(k)) {
          removed.push(p)
          continue
        }
        out[k] = walk(x, p, !dataKeys && DATA_KEYED_MAPS.has(k))
      }
      return out
    }
    return v
  }
  return { value: walk(value, rootPath, false) as T, removed }
}
