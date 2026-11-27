/** 생성 계획 — 전체 / 부족분만 / 실패만, 장수·예상 Anlas·시간·경고를 보고 대기열에 넣는다 */
import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { cx } from '../../lib/util'
import { formatDuration, planJobs, planWarnings, useProjects, type MatrixSelection, type PlanMode, type Project } from '../../project'
import { enqueueJobs, estimateFor, referenceNotes } from '../../project/run'
import { useGeneration } from '../../stores/generation'
import { useRefs } from '../../stores/refs'
import { useSettings } from '../../stores/settings'
import { toast } from '../../stores/toast'
import { Button, Row, Sheet, Stepper, Toggle } from '../ui'
import { Segmented } from './common'

const MODES: { value: PlanMode; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'missing', label: '부족분만' },
  { value: 'failed', label: '실패만' }
]

const MODE_HINT: Record<PlanMode, string> = {
  all: '조합마다 정한 장수를 모두 생성합니다 (이미 있는 그림과 상관없이)',
  missing: '채택 목표에서 이미 채택한 장수와 대기·생성 중인 장수를 뺀 만큼만',
  failed: '"재생성 필요" 상태인 조합만 (실패했거나, 다 골랐는데 목표에 못 미친 조합)'
}

export function PlanSheet(props: { project: Project; selection?: MatrixSelection; onClose: () => void }): ReactNode {
  const p = props.project
  const [mode, setMode] = useState<PlanMode>('all')
  const [perMissing, setPerMissing] = useState(1)
  const [countUnreviewed, setCountUnreviewed] = useState(false)
  const [scoped, setScoped] = useState(!!props.selection)
  const running = useGeneration((s) => s.running)
  // 예상에 쓰는 정보가 바뀌면 다시 계산한다
  const sub = useSettings((s) => s.subscription)
  const token = useSettings((s) => s.token)
  const refs = useRefs()

  const plan = useMemo(
    () => planJobs(p, mode, { ...(scoped && props.selection ? { select: props.selection } : {}), perMissing, countUnreviewed }),
    [p, mode, perMissing, countUnreviewed, scoped, props.selection]
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const estimate = useMemo(() => estimateFor(p, plan.jobs), [p, plan, sub, refs])
  const warnings = planWarnings(plan, estimate, p.limits)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const notes = useMemo(() => referenceNotes(p), [p, refs])
  const blocked = warnings.some((w) => w.level === 'error')
  const characters = new Set(plan.jobs.map((j) => j.character?.id ?? '')).size

  const go = (): void => {
    const heavy = warnings.filter((w) => w.level === 'warn' && w.code !== 'emptyAxis')
    if (heavy.length && !window.confirm(`${heavy.map((w) => `• ${w.message}`).join('\n')}\n\n그래도 ${estimate.images}장을 생성할까요?`)) return
    const r = enqueueJobs(p, plan.jobs)
    if (typeof r === 'string') {
      toast(r, true)
      return
    }
    toast(`${r.images}장(배치 ${r.batches}개)을 ${running ? '대기열에 넣었습니다' : '생성합니다'}${r.notes.length ? ` — ${r.notes.join(' · ')}` : ''}`, r.notes.length > 0)
    props.onClose()
  }

  return (
    <Sheet
      title="생성 계획"
      onClose={props.onClose}
      footer={
        <Button variant="primary" className="flex-1" disabled={!estimate.images || blocked || !token} onClick={go}>
          {!token ? '설정에서 토큰을 넣어 주세요' : estimate.images ? `${estimate.images}장 ${running ? '대기열에 추가' : '생성 시작'}` : '생성할 장이 없습니다'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Segmented label="계획 종류" value={mode} options={MODES} onChange={setMode} />
        <p className="text-xs text-dim">{MODE_HINT[mode]}</p>

        <div className="rounded-lg border border-line bg-field px-3">
          {mode === 'all' && (
            <Row label="조합마다 장수" hint="프로젝트 기본값 (조합별 덮어쓰기가 있으면 그것이 먼저)">
              <Stepper
                label="조합마다 장수"
                value={p.defaults.count}
                min={1}
                max={99}
                onChange={(count) => useProjects.getState().patch(p.id, { defaults: { ...p.defaults, count } })}
              />
            </Row>
          )}
          {mode === 'missing' && (
            <>
              <Row label="부족한 1장당 생성" hint="골라서 1장을 채택하려면 보통 여러 장이 필요합니다">
                <Stepper label="부족한 1장당 생성" value={perMissing} min={1} max={20} onChange={setPerMissing} />
              </Row>
              <Row label="고르지 않은 그림도 채운 것으로" hint="미선별·보류 그림을 채택 후보로 셈 (먼저 고를 생각이면 켜기)">
                <Toggle label="고르지 않은 그림도 채운 것으로" checked={countUnreviewed} onChange={setCountUnreviewed} />
              </Row>
            </>
          )}
          <Row label="채택 목표" hint="조합마다 채택할 장수 (설정에서 바꿈)">
            <span className="font-mono text-sm">{p.defaults.target}장</span>
          </Row>
          {props.selection && (
            <Row label="행렬에서 거른 조합만" hint="행렬 화면의 축 값 거르기 범위">
              <Toggle label="행렬에서 거른 조합만" checked={scoped} onChange={setScoped} />
            </Row>
          )}
        </div>

        <section aria-label="예상" className="rounded-lg border border-line bg-panel p-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="조합" value={plan.jobs.length} />
            <Stat label="장수" value={estimate.images} />
            <Stat label="배치" value={characters} />
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-dim">예상 Anlas</dt>
            <dd className="text-right font-mono">
              {estimate.anlas.toLocaleString('ko-KR')}
              {estimate.anlas > 0 && (
                <span className="text-dim">
                  {' '}
                  (생성 {estimate.generationAnlas} · 레퍼런스 {estimate.referenceAnlas} · 바이브 인코딩 {estimate.vibeAnlas})
                </span>
              )}
            </dd>
            {estimate.freeImages > 0 && (
              <>
                <dt className="text-dim">Opus 무료</dt>
                <dd className="text-right font-mono">{estimate.freeImages}장{estimate.opusUsageImages ? ` (V5 할당량 ${estimate.opusUsageImages}장)` : ''}</dd>
              </>
            )}
            <dt className="text-dim">예상 시간</dt>
            <dd className="text-right font-mono">{estimate.images ? formatDuration(estimate.seconds) : '-'}</dd>
          </dl>
          {!sub && <p className="mt-2 text-[11px] text-dim">계정 정보를 아직 읽지 못해 Opus 무료 여부를 모르고 계산했습니다</p>}
        </section>

        {(warnings.length > 0 || notes.length > 0) && (
          <ul aria-label="경고" className="flex flex-col gap-1.5">
            {warnings.map((w) => (
              <li
                key={w.code + w.message}
                className={cx(
                  'flex gap-2 rounded-lg px-3 py-2 text-xs',
                  w.level === 'error' ? 'bg-danger/15 text-danger' : w.level === 'warn' ? 'bg-tag-meta/15 text-tag-meta' : 'bg-raised text-dim'
                )}
              >
                {w.level === 'info' ? <Info size={15} className="shrink-0" /> : <AlertTriangle size={15} className="shrink-0" />}
                {w.message}
              </li>
            ))}
            {notes.map((n) => (
              <li key={n} className="flex gap-2 rounded-lg bg-raised px-3 py-2 text-xs text-dim">
                <Info size={15} className="shrink-0" />
                {n}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-dim">
          1장씩 요청하며, 장 사이 간격·중지·대기열은 일반 생성과 같습니다. 캐릭터마다 배치 하나로 나눠 대기열에 넣고, 멈추면 남은 장은
          "생성 대기"에서 빠집니다.
        </p>
      </div>
    </Sheet>
  )
}

function Stat(props: { label: string; value: number }): ReactNode {
  return (
    <div>
      <div className="font-mono text-lg font-semibold tabular-nums">{props.value.toLocaleString('ko-KR')}</div>
      <div className="text-[11px] text-dim">{props.label}</div>
    </div>
  )
}
