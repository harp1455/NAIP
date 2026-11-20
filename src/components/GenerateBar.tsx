import { useEffect, useState, type ReactNode } from 'react'
import { SlidersHorizontal, Square } from 'lucide-react'
import { useGeneration } from '../stores/generation'
import { usePrompt } from '../stores/prompt'
import { useSettings } from '../stores/settings'
import { IconButton, Stepper } from './ui'

const PHASE_LABEL = {
  idle: '',
  preparing: '레퍼런스 준비 중',
  generating: '생성 중',
  waiting: '다음 장 대기',
  retrying: '재시도 대기'
} as const

function formatLeft(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  return min < 60 ? `${min}분 ${sec % 60}초` : `${Math.floor(min / 60)}시간 ${min % 60}분`
}

/** 남은 시간: 지금까지의 장당 평균으로 추정 (1초마다 갱신) */
function useTimeLeft(): string | null {
  const { running, startedAt, done, failed, total } = useGeneration()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  const settled = done + failed
  if (!running || settled === 0 || settled >= total) return null
  const elapsed = Date.now() - startedAt
  return formatLeft((elapsed / settled) * total - elapsed)
}

export function GenerateBar(props: {
  openParams: () => void
  /** 씬 탭에서는 장수 대신 예약분을 생성한다 */
  scene?: { ids: number[]; count: number; cost: number }
}): ReactNode {
  const g = useGeneration()
  const count = usePrompt((s) => s.count)
  const setPrompt = usePrompt((s) => s.set)
  const { delayMin, delayMax } = useSettings()
  const left = useTimeLeft()
  const settled = g.done + g.failed
  const pct = g.total ? Math.round((settled / g.total) * 100) : 0
  const scene = props.scene
  const batch = scene ? scene.count : count

  return (
    <div className="border-t border-line bg-panel px-3 pb-2 pt-2">
      {g.error && (
        <p role="alert" className="mb-2 line-clamp-3 break-all rounded-md bg-danger/15 px-2.5 py-1.5 text-xs text-danger">
          {g.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <IconButton label="생성 설정" onClick={props.openParams} className="h-11 w-11">
          <SlidersHorizontal size={18} />
        </IconButton>
        {!scene && (
          <Stepper label="장수" value={count} min={1} max={999} onChange={(v) => setPrompt({ count: v })} />
        )}
        {g.running ? (
          <button
            type="button"
            onClick={g.stop}
            className="relative flex h-11 min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden rounded-lg bg-raised text-sm font-semibold"
          >
            <span
              className="absolute inset-y-0 left-0 bg-accent/30 transition-[width]"
              style={{ width: `${pct}%` }}
            />
            <Square size={14} className="relative fill-current" />
            <span className="relative truncate">
              중지 · {PHASE_LABEL[g.phase]} {Math.min(settled + 1, g.total)}/{g.total}
            </span>
          </button>
        ) : scene ? (
          <button
            type="button"
            disabled={scene.count === 0}
            onClick={() => void g.start(scene.ids)}
            className="h-11 min-w-0 flex-1 rounded-lg bg-accent text-sm font-semibold text-accent-fg active:brightness-90"
          >
            {scene.count === 0
              ? '씬에 장수를 예약하세요'
              : `예약 ${scene.count}장 생성${scene.cost > 0 ? ` · ${scene.cost} Anlas` : ''}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void g.start()}
            className="h-11 min-w-0 flex-1 rounded-lg bg-accent text-sm font-semibold text-accent-fg active:brightness-90"
          >
            생성
          </button>
        )}
      </div>
      <p className="mt-1.5 text-center text-[11px] text-dim">
        {g.running && left
          ? `남은 시간 약 ${left} · `
          : batch > 1
            ? `1장씩 ${batch}번 요청 · `
            : ''}
        장 사이 간격 {delayMin.toFixed(1)}~{delayMax.toFixed(1)}초
        {g.failed > 0 && !g.running ? ` · 실패 ${g.failed}장` : ''}
      </p>
    </div>
  )
}
