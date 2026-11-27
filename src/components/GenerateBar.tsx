import { useEffect, useState, type ReactNode } from 'react'
import { cx } from '../lib/util'
import { ListPlus, SlidersHorizontal, Square, X } from 'lucide-react'
import { useGeneration } from '../stores/generation'
import { usePrompt } from '../stores/prompt'
import { useSettings } from '../stores/settings'
import { Button, Empty, IconButton, Sheet, Stepper } from './ui'

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

/** 지금 도는 배치와 대기 중인 배치 목록 */
function QueueSheet(props: { onClose: () => void }): ReactNode {
  const g = useGeneration()
  return (
    <Sheet
      title="생성 대기열"
      onClose={props.onClose}
      footer={
        g.queue.length > 0 && (
          <Button
            variant="danger"
            className="flex-1"
            onClick={() => {
              for (const b of g.queue) g.removeQueued(b.id)
            }}
          >
            대기 중인 배치 모두 취소
          </Button>
        )
      }
    >
      {g.running && (
        <div className="mb-3 rounded-lg border border-accent bg-accent/10 px-3 py-2.5">
          <div className="text-xs text-accent">지금 생성 중</div>
          <div className="truncate text-sm">{g.currentLabel}</div>
          <div className="text-xs text-dim">
            {g.done}/{g.total}장 완료
          </div>
        </div>
      )}
      {g.queue.length === 0 ? (
        <Empty>대기 중인 배치가 없습니다. 생성 중에 오른쪽 + 단추를 누르면 그 순간의 설정이 여기에 쌓입니다.</Empty>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {g.queue.map((b, i) => (
            <li key={b.id} className="flex items-center gap-2 rounded-lg border border-line bg-field py-1 pl-3 pr-1">
              <span className="w-5 shrink-0 font-mono text-xs text-dim">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{b.label}</span>
              <IconButton label={`${b.label} 취소`} onClick={() => g.removeQueued(b.id)}>
                <X size={17} />
              </IconButton>
            </li>
          ))}
        </ol>
      )}
      <p className={cx('mt-3 text-xs text-dim')}>
        대기열은 누른 순간의 프롬프트·설정·캐릭터·레퍼런스를 그대로 기억합니다. 씬은 그 순간의 예약 장수를 가져가고,
        취소하면 예약으로 돌려줍니다.
      </p>
    </Sheet>
  )
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
  const [queueOpen, setQueueOpen] = useState(false)

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
          <>
          <button
            type="button"
            onClick={() => {
              if (g.queue.length && !window.confirm(`지금 배치를 멈추고 대기 중인 ${g.queue.length}개도 취소할까요?`)) return
              g.stop()
            }}
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
          {/* 생성 중에 지금 화면의 설정으로 다음 배치를 예약한다 */}
          <button
            type="button"
            aria-label={scene ? '예약한 씬을 대기열에 추가' : '지금 설정을 대기열에 추가'}
            title="대기열에 추가"
            disabled={!!scene && scene.count === 0}
            onClick={() => void g.start(scene ? { scenes: scene.ids } : undefined)}
            className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg active:brightness-90 disabled:opacity-40"
          >
            <ListPlus size={19} />
          </button>
          </>
        ) : scene ? (
          <button
            type="button"
            disabled={scene.count === 0}
            onClick={() => void g.start({ scenes: scene.ids })}
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
      {g.queue.length > 0 && (
        <button
          type="button"
          onClick={() => setQueueOpen(true)}
          className="mt-1.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-accent/10 text-xs text-accent"
        >
          <ListPlus size={14} />
          대기 중 {g.queue.length}개 · {g.queue.reduce((n, b) => n + b.count, 0)}장 — 눌러서 보기
        </button>
      )}
      {queueOpen && <QueueSheet onClose={() => setQueueOpen(false)} />}
      <p className="mt-1.5 text-center text-[11px] text-dim">
        {g.running && left
          ? `남은 시간 약 ${left} · `
          : batch > 1
            ? `1장씩 ${batch}번 요청 · `
            : ''}
        장 사이 간격 {delayMin.toFixed(1)}~{delayMax.toFixed(1)}초
        {g.failed > 0 && !g.running ? ` · 실패 ${g.failed}장` : ''}
        {!g.running && g.lastBatch ? ` · 지난 배치 장당 ${(g.lastBatch.perImageMs / 1000).toFixed(1)}초` : ''}
      </p>
    </div>
  )
}
