import { Capacitor, registerPlugin } from '@capacitor/core'
import { blobToBase64 } from './image'

/** android/app/src/main/java/.../NaipNativePlugin.java 와 짝 */
interface NaipNativePlugin {
  saveToGallery(opts: { base64: string; fileName: string; mimeType: string }): Promise<{ uri: string }>
  setKeepAwake(opts: { on: boolean }): Promise<void>
}

const NaipNative = registerPlugin<NaipNativePlugin>('NaipNative')
export const isNative = Capacitor.isNativePlatform()

export function fileNameFor(id: number, seed: number, mime: string): string {
  const d = new Date(id)
  const p = (n: number, l = 2): string => String(n).padStart(l, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
  return `NAIP_${stamp}_${seed}.${mime === 'image/webp' ? 'webp' : 'png'}`
}

/** 갤러리(Pictures/NAIP)에 저장. 웹에서는 다운로드로 대체 */
export async function saveToGallery(blob: Blob, fileName: string): Promise<void> {
  if (isNative) {
    await NaipNative.saveToGallery({
      base64: await blobToBase64(blob),
      fileName,
      mimeType: blob.type || 'image/png'
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
