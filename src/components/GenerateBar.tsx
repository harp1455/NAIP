import type { ReactNode } from 'react'
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

export function GenerateBar(props: { openParams: () => void }): ReactNode {
  const g = useGeneration()
  const count = usePrompt((s) => s.count)
  const setPrompt = usePrompt((s) => s.set)
  const { delayMin, delayMax } = useSettings()
  const settled = g.done + g.failed
  const pct = g.total ? Math.round((settled / g.total) * 100) : 0

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
        <Stepper label="장수" value={count} min={1} max={999} onChange={(v) => setPrompt({ count: v })} />
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
        {count > 1 ? `1장씩 ${count}번 요청 · ` : ''}장 사이 간격 {delayMin.toFixed(1)}~
        {delayMax.toFixed(1)}초
        {g.failed > 0 && !g.running ? ` · 실패 ${g.failed}장` : ''}
      </p>
    </div>
  )
}
