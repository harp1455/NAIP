import { Capacitor, registerPlugin, type Plugin } from '@capacitor/core'
import { blobToBase64 } from './image'
import { sleep } from './util'

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
  delay(opts: { ms: number }): Promise<void>
  copyImage(opts: { base64: string; mimeType: string }): Promise<void>
  haptic(): Promise<void>
  copyText(opts: { text: string; label?: string }): Promise<void>
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

/**
 * ms 만큼 기다린다. 앱이 화면에 없을 때 웹뷰는 JS 타이머를 크게 늦추기 때문에(몇 초~1분 단위),
 * 휴대폰에서는 네이티브 타이머로 기다려 백그라운드 생성의 장 사이 간격이 늘어지지 않게 한다.
 */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!isNative) return sleep(ms, signal)
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new DOMException('Aborted', 'AbortError'))
    if (signal?.aborted) return aborted()
    signal?.addEventListener('abort', aborted, { once: true })
    NaipNative.delay({ ms }).then(
      () => {
        signal?.removeEventListener('abort', aborted)
        resolve()
      },
      // 플러그인 호출이 실패하면 JS 타이머로 기다린다
      () => {
        signal?.removeEventListener('abort', aborted)
        sleep(ms, signal).then(resolve, reject)
      }
    )
  })
}

/**
 * 이미지를 클립보드에 복사한다. 휴대폰에서는 앱 캐시에 파일을 만들고 그 주소(content://)를
 * 클립보드에 올린다 — 메신저 입력창이나 키보드의 클립보드에서 붙여 넣을 수 있다.
 */
export async function copyImageToClipboard(blob: Blob): Promise<void> {
  if (isNative) {
    await NaipNative.copyImage({ base64: await blobToBase64(blob), mimeType: blob.type || 'image/png' })
    return
  }
  // 브라우저 클립보드는 PNG만 받는다
  const png = blob.type === 'image/png' ? blob : await toPng(blob)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 변환 실패'))), 'image/png')
  )
}

/** 꾹 눌렀을 때의 짧은 진동 */
export function haptic(): void {
  if (isNative) void NaipNative.haptic().catch(() => {})
  else navigator.vibrate?.(15)
}

/** 여러 장을 한 번에 공유 (공유 창에서 앱을 고른다) */
export async function shareImages(files: { blob: Blob; fileName: string }[]): Promise<void> {
  if (files.length === 1) return shareImage(files[0].blob, files[0].fileName)
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    const { Share } = await import('@capacitor/share')
    const uris: string[] = []
    for (const f of files) {
      const res = await Filesystem.writeFile({
        path: `share/${f.fileName}`,
        data: await blobToBase64(f.blob),
        directory: Directory.Cache,
        recursive: true
      })
      uris.push(res.uri)
    }
    await Share.share({ files: uris })
    return
  }
  const list = files.map((f) => new File([f.blob], f.fileName, { type: f.blob.type }))
  if (navigator.canShare?.({ files: list })) await navigator.share({ files: list })
  else throw new Error('이 브라우저는 여러 장 공유를 지원하지 않습니다')
}

/** 진행 알림의 "중지" 단추를 눌렀을 때 */
export function onStopRequested(handler: () => void): () => void {
  if (!isNative) return () => {}
  const handle = NaipNative.addListener('stopRequested', handler)
  return () => void handle.then((h) => h.remove())
}

/** 글자를 클립보드에 복사 */
export async function copyText(text: string, label = 'NAIP'): Promise<void> {
  if (isNative) await NaipNative.copyText({ text, label })
  else await navigator.clipboard.writeText(text)
}
