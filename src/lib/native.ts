import { Capacitor, registerPlugin, type Plugin } from '@capacitor/core'
import { blobToBase64 } from './image'

/** android/app/src/main/java/.../NaipNativePlugin.java 와 짝 */
interface NaipNativePlugin extends Plugin {
  httpGet(opts: { url: string; token?: string }): Promise<{ status: number; body: string }>
  installUpdate(opts: { url: string; token?: string }): Promise<void>
  saveToGallery(opts: {
    base64: string
    fileName: string
    mimeType: string
    folder?: string
  }): Promise<{ uri: string }>
  setKeepAwake(opts: { on: boolean }): Promise<void>
  readClipboard(): Promise<{ text: string }>
  startJob(opts: { text: string }): Promise<void>
  updateJob(opts: { text: string; done: number; total: number }): Promise<void>
  stopJob(opts: { text?: string; vibrate: boolean }): Promise<void>
}

const NaipNative = registerPlugin<NaipNativePlugin>('NaipNative')
export const isNative = Capacitor.isNativePlatform()

export function fileNameFor(id: number, seed: number, mime: string): string {
  const d = new Date(id)
  const p = (n: number, l = 2): string => String(n).padStart(l, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
  return `NAIP_${stamp}_${seed}.${mime === 'image/webp' ? 'webp' : 'png'}`
}

/** 파일·폴더 이름에 쓸 수 없는 문자를 걷어 낸다 */
export function cleanFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
}

/** 갤러리(Pictures/NAIP)에 저장. 웹에서는 다운로드로 대체 */
export async function saveToGallery(blob: Blob, fileName: string, folder?: string): Promise<void> {
  if (isNative) {
    const sub = folder ? cleanFileName(folder) : ''
    await NaipNative.saveToGallery({
      base64: await blobToBase64(blob),
      fileName,
      mimeType: blob.type || 'image/png',
      ...(sub ? { folder: sub } : {})
    })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export async function shareImage(blob: Blob, fileName: string): Promise<void> {
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    const { Share } = await import('@capacitor/share')
    const res = await Filesystem.writeFile({
      path: `share/${fileName}`,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true
    })
    await Share.share({ files: [res.uri] })
    return
  }
  const file = new File([blob], fileName, { type: blob.type })
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] })
  else await saveToGallery(blob, fileName)
}

export function setKeepAwake(on: boolean): void {
  if (isNative) void NaipNative.setKeepAwake({ on }).catch(() => {})
}

/** 백그라운드 생성용 포그라운드 서비스 + 진행 알림 (웹에서는 아무것도 하지 않음) */
export const job = {
  start(text: string): void {
    if (isNative) void NaipNative.startJob({ text }).catch(() => {})
  },
  update(text: string, done: number, total: number): void {
    if (isNative) void NaipNative.updateJob({ text, done, total }).catch(() => {})
  },
  /** text를 주면 앱이 뒤에 있을 때 완료 알림을 남긴다 */
  stop(text: string | undefined, vibrate: boolean): void {
    if (isNative) void NaipNative.stopJob({ ...(text ? { text } : {}), vibrate }).catch(() => {})
    else if (vibrate) navigator.vibrate?.(200)
  }
}

/** 클립보드의 텍스트. 웹뷰는 clipboard-read 권한이 없어 네이티브로 읽는다 */
export async function readClipboard(): Promise<string> {
  if (isNative) return (await NaipNative.readClipboard()).text
  return navigator.clipboard.readText()
}

/** GitHub API GET — 네이티브에서는 CORS와 무관하게 플러그인으로 요청한다 */
export async function githubGet(url: string, token?: string): Promise<{ status: number; body: string }> {
  if (isNative) return NaipNative.httpGet({ url, ...(token ? { token } : {}) })
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  })
  return { status: res.status, body: await res.text() }
}

/** APK를 내려받아 설치 화면을 띄운다. 웹에서는 다운로드 주소를 연다 */
export async function installUpdate(
  url: string,
  token: string | undefined,
  onProgress: (received: number, total: number) => void,
  fallbackUrl: string
): Promise<void> {
  if (!isNative) {
    window.open(fallbackUrl, '_blank')
    return
  }
  const handle = await NaipNative.addListener('updateProgress', (p: { received: number; total: number }) =>
    onProgress(p.received, p.total)
  )
  try {
    await NaipNative.installUpdate({ url, ...(token ? { token } : {}) })
  } finally {
    void handle.remove()
  }
}
