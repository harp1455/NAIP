import { useEffect, useState, type ReactNode } from 'react'
import { loadImage, makeThumb } from '../lib/image'
import { readImageSettings } from '../lib/metadata'
import { clearCache, formatBytes, getStorage, storageInfo } from '../storage'
import { checkStorage, deleteStoredFiles, recoverOrphans, type CheckReport } from '../storage/check'
import { idbLegacySource } from '../storage/legacy'
import type { StorageInfo } from '../storage/native'
import { useGeneration } from '../stores/generation'
import { useHistory } from '../stores/history'
import { useStorageBoot } from '../stores/storage'
import { toast } from '../stores/toast'
import { Button, Row } from './ui'

/** 그림 하나에서 히스토리 기록에 필요한 것 (기록 없는 원본 되살리기용) */
async function describe(blob: Blob): Promise<{
  width: number
  height: number
  seed: number
  model: string
  prompt: string
  negative: string
  thumb: string
}> {
  const img = await loadImage(blob)
  const m = await readImageSettings(blob).catch(() => null)
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    seed: m?.seed ?? 0,
    model: m?.model ?? 'unknown',
    prompt: m?.prompt ?? '',
    negative: m?.negative ?? '',
    thumb: await makeThumb(blob)
  }
}

/** 설정 → 저장 공간: 앱이 쓰는 크기·캐시·갤러리 저장 수, 점검과 정리 */
export function StorageGroup(): ReactNode {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [report, setReport] = useState<CheckReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const running = useGeneration((g) => g.running)
  const total = useHistory((h) => h.total)
  const { legacyLeft, migrate, phase } = useStorageBoot()

  const refresh = async (): Promise<void> => {
    const [i, s] = await Promise.all([
      storageInfo().catch(() => null),
      getStorage()
        .then((x) => x.history.savedCount())
        .catch(() => null)
    ])
    setInfo(i)
    setSaved(s)
  }
  useEffect(() => {
    void refresh()
  }, [total])

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      toast(`${label} 실패: ${(e as Error).message}`, true)
    } finally {
      setBusy(null)
    }
  }
  const check = (): Promise<void> => run('점검', async () => setReport(await checkStorage(await getStorage())))

  const appBytes = info ? info.dbBytes + info.imagesBytes + info.thumbsBytes : 0
  const problems = report
    ? report.orphanOriginals.length + report.orphanThumbs.length + report.leftovers.length + report.missingOriginals.length + report.sizeMismatch.length
    : 0

  return (
    <>
      <Row
        label="앱 저장 공간"
        hint={
          info
            ? `원본 ${formatBytes(info.imagesBytes)} · 썸네일 ${formatBytes(info.thumbsBytes)}${info.dbBytes ? ` · 기록 ${formatBytes(info.dbBytes)}` : ''} · 기기 남은 공간 ${formatBytes(info.free)}`
            : '계산하는 중…'
        }
      >
        <span className="font-mono text-sm tabular-nums" data-testid="app-bytes">
          {info ? formatBytes(appBytes) : '…'}
        </span>
      </Row>
      <Row label="갤러리에 저장한 그림" hint="히스토리 중 Pictures/NAIP에 저장한 장수">
        <span className="font-mono text-sm tabular-nums" data-testid="saved-count">
          {saved === null ? '…' : `${saved.toLocaleString()}장`}
        </span>
      </Row>
      <Row label="캐시" hint={`공유·복사할 때 만든 사본, 받은 업데이트 파일${info ? ` · ${formatBytes(info.cacheBytes)}` : ''}`}>
        <Button
          variant="ghost"
          disabled={!!busy}
          onClick={() =>
            void run('캐시 비우기', async () => {
              const freed = await clearCache()
              toast(`캐시를 비웠습니다${freed ? ` (${formatBytes(freed)})` : ''}`)
              await refresh()
            })
          }
        >
          캐시 비우기
        </Button>
      </Row>
      <Row label="저장 공간 점검" hint="기록과 파일이 서로 맞는지 봅니다. 찾은 것은 고르기 전에는 지우지 않습니다">
        <Button disabled={!!busy || running} onClick={() => void check()}>
          {busy === '점검' ? '점검 중…' : '점검'}
        </Button>
      </Row>
      {report && (
        <div className="mb-2 rounded-lg border border-line bg-field p-2.5 text-xs" data-testid="check-report">
          <p className={problems ? 'text-fg' : 'text-ok'}>
            기록 {report.rows.toLocaleString()}개 확인 — {problems ? `손볼 것 ${problems}개` : '문제 없음'}
            {report.missingThumbs.length ? ` · 썸네일 없음 ${report.missingThumbs.length}개(볼 때 다시 만듭니다)` : ''}
          </p>
          {report.orphanOriginals.length > 0 && (
            <div className="mt-2">
              <p>
                기록 없는 원본 {report.orphanOriginals.length}개 (
                {formatBytes(report.orphanOriginals.reduce((a, o) => a + o.size, 0))}) — 저장 중에 앱이 꺼져 남은 그림일 수 있습니다
              </p>
              <div className="mt-1 flex gap-1.5">
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    void run('되살리기', async () => {
                      // 예전 히스토리에 아직 있는 장은 되살리지 않는다 — 옮기기가 원래 기록과 함께 옮긴다
                      const r = await recoverOrphans(await getStorage(), report.orphanOriginals, describe, idbLegacySource())
                      toast(
                        `${r.recovered}장을 히스토리로 되살렸습니다` +
                          (r.waiting ? ` · ${r.waiting}장은 이전 히스토리 옮기기에서 원래 기록과 함께 옮깁니다` : '')
                      )
                      await useHistory.getState().init()
                      await check()
                    })
                  }
                >
                  히스토리로 되살리기
                </Button>
                <Button
                  variant="danger"
                  disabled={!!busy}
                  onClick={() => {
                    if (!window.confirm(`기록 없는 원본 ${report.orphanOriginals.length}개를 지울까요? 되돌릴 수 없습니다.`)) return
                    void run('원본 지우기', async () => {
                      await deleteStoredFiles(await getStorage(), report.orphanOriginals.map((o) => o.path))
                      await check()
                    })
                  }}
                >
                  지우기
                </Button>
              </div>
            </div>
          )}
          {report.orphanThumbs.length + report.leftovers.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <p className="min-w-0 flex-1">
                쓰지 않는 썸네일·임시 파일 {report.orphanThumbs.length + report.leftovers.length}개
              </p>
              <Button
                disabled={!!busy}
                onClick={() =>
                  void run('정리', async () => {
                    await deleteStoredFiles(await getStorage(), [...report.orphanThumbs, ...report.leftovers])
                    await check()
                  })
                }
              >
                정리
              </Button>
            </div>
          )}
          {report.missingOriginals.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <p className="min-w-0 flex-1">원본 파일이 없는 기록 {report.missingOriginals.length}개</p>
              <Button
                variant="danger"
                disabled={!!busy}
                onClick={() => {
                  if (!window.confirm(`원본이 없는 기록 ${report.missingOriginals.length}개를 히스토리에서 지울까요?`)) return
                  void run('기록 지우기', async () => {
                    await useHistory.getState().remove(report.missingOriginals)
                    await check()
                  })
                }}
              >
                기록 지우기
              </Button>
            </div>
          )}
          {report.sizeMismatch.length > 0 && (
            <p className="mt-2 text-danger">
              원본 크기가 기록과 다른 그림 {report.sizeMismatch.length}개 — 손상됐을 수 있습니다. 자동으로 지우지 않습니다.
            </p>
          )}
        </div>
      )}
      {legacyLeft > 0 && phase === 'ready' && (
        <Row label="이전 히스토리 옮기기" hint={`아직 옮기지 못한 예전 히스토리 ${legacyLeft.toLocaleString()}장이 있습니다`}>
          <Button variant="primary" disabled={running} onClick={() => void migrate()}>
            옮기기
          </Button>
        </Row>
      )}
    </>
  )
}
