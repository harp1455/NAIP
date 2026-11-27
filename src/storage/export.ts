import { cleanFileName, isNative, saveToGallery } from '../lib/native'
import { getStorage } from './index'
import { originalPath } from './history-repo'
import { NaipStorage } from './native'

/**
 * 히스토리 원본을 밖으로 내보내기 — 휴대폰은 앱 전용 폴더의 파일에서 바로 복사한다 (base64로 웹뷰를 거치지 않는다).
 * 메타데이터를 지워야 할 때는 그림을 다시 만들어야 하므로 부르는 쪽이 예전처럼 Blob으로 처리한다.
 */

/** 갤러리(Pictures/NAIP[/폴더])에 저장. image는 웹에서의 대체 경로와 MIME에 쓴다 */
export async function saveHistoryImageToGallery(id: number, image: Blob, fileName: string, folder?: string): Promise<void> {
  if (!isNative) return saveToGallery(image, fileName, folder)
  await saveStoredToGallery(id, image.type || 'image/png', fileName, folder)
}

/** 원본 파일을 그대로 갤러리에 저장 (휴대폰 전용) */
export async function saveStoredToGallery(id: number, mime: string, fileName: string, folder?: string): Promise<void> {
  await getStorage()
  const sub = folder ? cleanFileName(folder) : ''
  await NaipStorage.saveFileToGallery({
    path: originalPath(id, mime),
    fileName,
    mimeType: mime,
    ...(sub ? { folder: sub } : {})
  })
}

/** 원본 파일을 클립보드로 (휴대폰 전용) */
export async function copyStoredImage(id: number, mime: string): Promise<void> {
  await getStorage()
  await NaipStorage.copyImageFile({ path: originalPath(id, mime), mimeType: mime })
}

/** 원본 파일들을 공유 창으로 (휴대폰 전용) */
export async function shareStoredImages(items: { id: number; mime: string; fileName: string }[]): Promise<void> {
  await getStorage()
  const { uris } = await NaipStorage.prepareShare({
    items: items.map((i) => ({ path: originalPath(i.id, i.mime), name: i.fileName }))
  })
  const { Share } = await import('@capacitor/share')
  await Share.share({ files: uris })
}
