import { BackupError } from '../types'

/**
 * zip-slip 방지 — 아카이브 안 경로는 상대 경로, 슬래시 구분, `..`·`.`·빈 조각 없음.
 * NAIS3 archive.ts 의 assertSafeArchivePath (GPL-3.0, © sunanakgo) 규칙에 빈 조각·제어 문자·
 * 길이 제한을 더했다.
 */
export function unsafePathReason(path: string): string | null {
  if (!path) return '빈 경로'
  if (path.length > 512) return '경로가 너무 김'
  if (path.includes('\0')) return 'NUL 문자'
  if (path.includes('\\')) return '역슬래시'
  if (/[\u0000-\u001f\u007f]/.test(path)) return '제어 문자'
  if (path.startsWith('/')) return '절대 경로'
  if (/^[a-zA-Z]:/.test(path)) return '드라이브 경로'
  const parts = path.split('/')
  // 디렉터리 항목은 끝에 / 하나만 허용
  const body = path.endsWith('/') ? parts.slice(0, -1) : parts
  if (body.some((p) => p === '..')) return '상위 경로(..)'
  if (body.some((p) => p === '.')) return '현재 경로(.)'
  if (body.some((p) => p === '')) return '빈 경로 조각'
  return null
}

export function assertSafePath(path: string): void {
  const reason = unsafePathReason(path)
  if (reason) throw new BackupError('unsafe-path', `안전하지 않은 경로가 들어 있습니다 (${reason}): ${JSON.stringify(path)}`, path)
}
