/// <reference types="node" />
/**
 * 휴대폰 쪽 토큰 보관소(NaipSecurePlugin → SecretVault.java)를 데스크톱 JVM에서 돌린다.
 * SecretVault는 Android API를 쓰지 않아 javac로 바로 빌드된다. 키 저장소와 SharedPreferences는
 * tests/java/SecretVaultCheck.java가 흉내 낸다 (Android 12+ 키 저장소는 일시적인 오류에도 "키 없음"이라고 답한다).
 * JDK가 없는 곳에서는 건너뛴다 (CI는 APK를 빌드하려고 JDK를 설치한 뒤 테스트를 돌린다).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = [
  join(ROOT, 'android/app/src/main/java/io/github/harp1455/naip/SecretVault.java'),
  join(ROOT, 'tests/java/SecretVaultCheck.java')
]
const hasJdk = spawnSync('javac', ['-version'], { stdio: 'ignore' }).status === 0
let out = ''

function scenario(name: string): string {
  const r = spawnSync('java', ['-cp', out, 'io.github.harp1455.naip.SecretVaultCheck', name], { encoding: 'utf8' })
  // stderr에는 JVM 안내(Picked up …)도 섞이니, 실패 이유는 stdout을 먼저 본다
  return r.status === 0 ? 'ok' : r.stdout.trim() || r.stderr.trim()
}

describe.skipIf(!hasJdk)('NaipSecure store (SecretVault on a desktop JVM)', () => {
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'naip-vault-'))
    const r = spawnSync('javac', ['-encoding', 'UTF-8', '-d', out, ...SOURCES], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`javac failed:\n${r.stdout}${r.stderr}`)
  }, 120_000)
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true })
  })

  it('keeps the other token readable when the key looks missing while one token is written', () => {
    // 예전에는 토큰 둘이 키 하나를 같이 써서, 쓰는 순간 키가 없어 보이면 그 이름으로 새 키를 만들어
    // 다른 토큰까지 다시는 풀 수 없게 됐고, 다음 읽기에서 지워지며 "기기 보안 상태가 바뀌어" 안내가 떴다
    expect(scenario('otherTokenSurvivesFalseMissingOnWrite')).toBe('ok')
  })

  it('still reads values that an earlier version sealed with the shared key, and never replaces that key', () => {
    expect(scenario('legacySharedKeyValuesStayReadable')).toBe('ok')
  })

  it('keeps the old value readable when a new key was made but the write did not reach the disk', () => {
    expect(scenario('failedWriteAfterFalseMissingKeepsOldValue')).toBe('ok')
  })

  it('keeps the key of a value that failed to reach the disk, since a later commit may still write it', () => {
    expect(scenario('failedWriteThatLaterReachesDiskStaysReadable')).toBe('ok')
  })

  it('never deletes a value because the key store failed or said the key is missing', () => {
    expect(scenario('keystoreErrorsNeverDelete')).toBe('ok')
  })

  it('forgets only values that can never be decrypted', () => {
    expect(scenario('undecryptableValuesAreForgotten')).toBe('ok')
  })

  it('saves a new token over a value whose key is listed but unusable, without clearing it first', () => {
    // 키 덩어리가 깨지면(INVALID_KEY_BLOB 등) 키 저장소는 키가 있다고 답하면서 InvalidKeyException(영구 무효 아님)을 낸다.
    // 예전에는 set이 그 키를 계속 다시 써서 새 토큰을 영영 저장하지 못했다 (NovelAI 칸은 빈 값으로 지울 수도 없다)
    expect(scenario('unusableKeyIsReplacedOnWrite')).toBe('ok')
    expect(scenario('unreadableKeyIsReplacedOnWrite')).toBe('ok')
  })

  it('keeps both keys when a write over an unusable key does not reach the disk', () => {
    expect(scenario('failedWriteOverUnusableKeyKeepsBothKeys')).toBe('ok')
  })

  it('drops a new key it could not seal with and leaves the stored value alone', () => {
    expect(scenario('freshKeyThatCannotSealIsDropped')).toBe('ok')
  })

  it('clears with an empty value and round-trips Korean text', () => {
    expect(scenario('clearAndRoundTrip')).toBe('ok')
  })
})
