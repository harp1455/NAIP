/// <reference types="node" />
/**
 * 암호화한 토큰(NaipSecurePlugin의 SharedPreferences)은 기기를 옮길 때 따라가면 안 된다.
 * Android Keystore 키는 기기 밖으로 나가지 않으니, 새 휴대폰에서는 키 없이 암호문만 남아
 * "지금은 읽지 못했습니다 (지우지 않았습니다)"가 앱을 열 때마다 뜬다 (SecretVault는 키가 없어 보여도 지우지 않는다).
 * targetSdk 31+에서 allowBackup="false"는 클라우드 백업만 막고 기기 간 전송(D2D)은 막지 않으므로
 * dataExtractionRules로 그 파일을 뺀다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = join(ROOT, 'android/app/src/main')
const manifest = readFileSync(join(MAIN, 'AndroidManifest.xml'), 'utf8')
const plugin = readFileSync(join(MAIN, 'java/io/github/harp1455/naip/NaipSecurePlugin.java'), 'utf8')

/** NaipSecurePlugin이 쓰는 SharedPreferences 파일 이름 */
function securePrefsFile(): string {
  const m = /String PREFS = "([^"]+)"/.exec(plugin)
  if (!m) throw new Error('PREFS not found in NaipSecurePlugin.java')
  return `${m[1]}.xml`
}

/** <application>에 적힌 dataExtractionRules 파일 내용 (없으면 null) */
function extractionRules(): string | null {
  const app = /<application\b[^>]*>/.exec(manifest)?.[0] ?? ''
  const ref = /android:dataExtractionRules="@xml\/([A-Za-z0-9_]+)"/.exec(app)
  if (!ref) return null
  const file = join(MAIN, 'res/xml', `${ref[1]}.xml`)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** 그 구역(device-transfer·cloud-backup)이 이 shared_prefs 파일을 빼는지 */
function excludes(rules: string, section: string, prefsFile: string): boolean {
  const body = new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`).exec(rules.replace(/<!--[\s\S]*?-->/g, ''))?.[1]
  if (body === undefined) return false
  return [...body.matchAll(/<exclude\b([^>]*)\/>/g)].some(
    ([, attrs]) => /\bdomain="sharedpref"/.test(attrs) && new RegExp(`\\bpath="${prefsFile.replace('.', '\\.')}"`).test(attrs)
  )
}

describe('encrypted token store and device transfer', () => {
  it('keeps backups off', () => {
    expect(manifest).toMatch(/android:allowBackup="false"/)
  })

  it('leaves the encrypted tokens out of device-to-device transfers, since their Keystore keys stay behind', () => {
    const rules = extractionRules()
    expect(rules, 'android:dataExtractionRules in AndroidManifest.xml pointing at res/xml').not.toBeNull()
    expect(excludes(rules!, 'device-transfer', securePrefsFile())).toBe(true)
  })

  it('leaves them out of cloud backups too, should backups ever be turned on', () => {
    expect(excludes(extractionRules() ?? '', 'cloud-backup', securePrefsFile())).toBe(true)
  })
})
