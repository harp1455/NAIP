/**
 * 행렬 — 맨 위에 "다음에 할 일"(단계 · 지금 할 일 단추), 채택 진행과 상태로 거르기, 축 값으로 거르기(값마다 진행),
 * 조합 칸(첫 축으로 묶음). 칸을 누르면 선별 화면, "선별하기"는 고를 조합을 차례로 연다
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { LayoutGrid, List, Play, Tags } from 'lucide-react'
import { cx } from '../../lib/util'
import {
  ASSET_STATUS_LABEL,
  curationCounts,
  expandMatrix,
  itemStatus,
  matrixTotals,
  orphanItems,
  parseComboKey,
  progressByValue,
  projectAxes,
  projectGuide,
  representativeOf,
  reviewQueue,
  type AssetItem,
  type AssetStatus,
  type Combination,
  type MatrixSelection,
  type NextAction,
  type PlanMode,
  type Project
} from '../../project'
import { Button, Empty, Select } from '../ui'
import { ProgressBar, StatusBadge, STATUS_STYLE, Thumb, useMetas } from './common'
import { CurationSheet } from './CurationSheet'
import { NextStepCard } from './Guide'
import { PlanSheet } from './PlanSheet'
import { ClassifySheet } from './ClassifySheet'

const STATUSES = Object.keys(ASSET_STATUS_LABEL) as AssetStatus[]

/** 한 번에 그리는 조합 칸 수 — 조합이 수천~수만 개여도 그림이 들어올 때마다 화면이 멈추지 않게 "더 보기"로 늘린다 */
const PAGE = 200

export function MatrixView(props: { project: Project; onEdit: () => void; onExport: () => void }): ReactNode {
  const p = props.project
  const { characters, axes: projectAxisList, exclusions, overrides, defaults, limits, params } = p
  // 행렬은 축·캐릭터·규칙·기본값만으로 정해진다 — 생성 중 그림이 들어올 때마다(항목만 바뀜) 다시 펼치지 않는다
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matrix = useMemo(() => expandMatrix(p), [characters, projectAxisList, exclusions, overrides, defaults, limits, params])
  const totals = useMemo(() => matrixTotals(p, matrix), [p, matrix])
  const guide = useMemo(() => projectGuide(p, matrix), [p, matrix])
  const orphans = useMemo(() => orphanItems(p, matrix), [p, matrix])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const axes = useMemo(() => projectAxes(p), [characters, projectAxisList])
  const [filter, setFilter] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<AssetStatus | ''>('')
  const [grid, setGrid] = useState(true)
  /** 연 조합 — review: 열자마자 한 장씩 고르기 (선별하기·다음 조합) */
  const [open, setOpen] = useState<{ key: string; review: boolean } | null>(null)
  /**
   * 연 생성 계획 — fill: 고르지 않은 그림도 채운 것으로 (카드의 "부족한 것만 생성"),
   * whole: 축 값 거르기와 상관없이 행렬 전체로 시작 (카드는 행렬 전체를 세므로 카드의 숫자와 같게)
   */
  const [planning, setPlanning] = useState<{ mode: PlanMode; fill?: boolean; whole?: boolean } | null>(null)
  const [classifying, setClassifying] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const pickStatus = (s: AssetStatus | ''): void => {
    setStatus(s)
    setLimit(PAGE)
  }

  const shown = matrix.combos.filter(
    (c) =>
      Object.entries(filter).every(([a, v]) => !v || c.coords[a] === v) &&
      (!status || itemStatus(p.items[c.key], c.target) === status)
  )
  const visible = shown.length > limit ? shown.slice(0, limit) : shown
  const reps = visible.map((c) => representativeOf(p.items[c.key])?.id).filter((id): id is number => id !== undefined)
  const metas = useMetas(reps)
  const selection: MatrixSelection | undefined = Object.values(filter).some(Boolean)
    ? { values: Object.fromEntries(Object.entries(filter).filter(([, v]) => v).map(([a, v]) => [a, [v]])) }
    : undefined
  // 축 값마다 진행 (거르기 칸의 "민지 1/5"와 묶음 머리)
  const byValue = useMemo(() => new Map(matrix.axes.map((a) => [a.id, progressByValue(p, matrix.combos, a.id)])), [p, matrix])
  // 첫 축으로 묶는다 (축이 둘 이상일 때 — 캐릭터마다 한 줄처럼)
  const groupAxis = matrix.axes.length >= 2 ? matrix.axes[0] : null
  const groups: { id: string; combos: Combination[] }[] = []
  for (const c of visible) {
    const id = groupAxis ? c.coords[groupAxis.id] : ''
    const last = groups[groups.length - 1]
    if (last && last.id === id) last.combos.push(c)
    else groups.push({ id, combos: [c] })
  }
  const openCell = useCallback((key: string) => setOpen({ key, review: false }), [])
  // 지금 연 조합 다음에 고를 조합 (지금 상태로 — 고르는 사이 바뀐다)
  const queue = open ? reviewQueue(p, matrix.combos, open.key) : []

  const act = (a: NextAction): void => {
    if (a.kind === 'setup' || a.kind === 'tooMany') props.onEdit()
    else if (a.kind === 'generate') setPlanning({ mode: 'all', whole: true })
    else if (a.kind === 'missing') setPlanning({ mode: 'missing', fill: true, whole: true })
    else if (a.kind === 'redo') setPlanning({ mode: 'failed', whole: true })
    else if (a.kind === 'export') props.onExport()
    else if (a.kind === 'review') {
      const first = reviewQueue(p, matrix.combos)[0]
      if (first) setOpen({ key: first, review: true })
    }
  }

  if (!matrix.combos.length && !matrix.tooMany) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-3">
          <NextStepCard guide={guide} onAction={act} />
          {matrix.warnings
            .filter((w) => w.code !== 'noAxes')
            .map((w) => (
              <p key={w.message} className="mt-2 text-xs text-dim">
                {w.message}
              </p>
            ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-3 pt-3">
          {/* 다음에 할 일 + 합계 · 상태로 거르기 */}
          <NextStepCard guide={guide} onAction={act}>
            <div role="group" aria-label="합계">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="font-semibold">
                  채택 {totals.adopted}/{totals.target}
                </span>
                <span className="text-xs text-dim">
                  조합 {totals.combos}개{totals.excluded ? ` (제외 ${totals.excluded})` : ''}
                </span>
                <span className="ml-auto font-mono text-xs text-dim">{Math.round(totals.progress * 100)}%</span>
              </div>
              <ProgressBar className="mt-2" value={totals.progress} label="채택 진행률" />
              <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="상태로 거르기">
                <button
                  type="button"
                  aria-pressed={status === ''}
                  onClick={() => pickStatus('')}
                  className={cx('h-8 rounded-full border px-2.5 text-[11px]', status === '' ? 'border-fg text-fg' : 'border-line text-dim')}
                >
                  전체 {totals.combos}
                </button>
                {STATUSES.filter((s) => totals.byStatus[s] || status === s).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={status === s}
                    onClick={() => pickStatus(status === s ? '' : s)}
                    className={cx('h-8 rounded-full px-2.5 text-[11px]', STATUS_STYLE[s], status === s && 'ring-2 ring-fg')}
                  >
                    {ASSET_STATUS_LABEL[s]} {totals.byStatus[s]}
                  </button>
                ))}
              </div>
              {matrix.warnings
                .filter((w) => w.code !== 'emptyAxis' || matrix.tooMany)
                .map((w) => (
                  <p key={w.message} className={cx('mt-2 text-xs', w.level === 'error' ? 'text-danger' : 'text-dim')}>
                    {w.message}
                  </p>
                ))}
            </div>
          </NextStepCard>
        </div>

        {/* 축 값으로 거르기 · 보기 — 내려도 위에 남는다. 축이 많으면 거르기 칸이 다음 줄로 (옆으로 숨지 않게) */}
        <div className="sticky top-0 z-10 mt-1 bg-bg/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-start gap-1 px-3 py-1.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="group" aria-label="거르기">
              {axes.map((a) => {
                const prog = byValue.get(a.id)
                return (
                  <Select
                    key={a.id}
                    label={`${a.name} 거르기`}
                    className="min-w-0 flex-[1_1_7.5rem] sm:max-w-44"
                    value={filter[a.id] ?? ''}
                    options={[
                      { value: '', label: `모든 ${a.name}` },
                      ...a.values
                        .filter((v) => v.enabled !== false)
                        .map((v) => {
                          const r = prog?.get(v.id)
                          return { value: v.id, label: r ? `${v.label} ${r.adopted}/${r.target}` : v.label }
                        })
                    ]}
                    onChange={(v) => {
                      setFilter({ ...filter, [a.id]: v })
                      setLimit(PAGE)
                    }}
                  />
                )
              })}
            </div>
            <div className="flex shrink-0">
              <button
                type="button"
                aria-label="격자로 보기"
                aria-pressed={grid}
                onClick={() => setGrid(true)}
                className={cx('flex h-11 w-10 items-center justify-center rounded-lg', grid ? 'bg-raised text-fg' : 'text-dim')}
              >
                <LayoutGrid size={17} />
              </button>
              <button
                type="button"
                aria-label="목록으로 보기"
                aria-pressed={!grid}
                onClick={() => setGrid(false)}
                className={cx('flex h-11 w-10 items-center justify-center rounded-lg', !grid ? 'bg-raised text-fg' : 'text-dim')}
              >
                <List size={17} />
              </button>
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-5xl px-3 pb-3">
          <p className="text-[11px] text-dim">
            {shown.length === matrix.combos.length ? `조합 ${shown.length}개` : `조합 ${shown.length}/${matrix.combos.length}개 표시`} · 칸의 숫자는 채택/목표
          </p>

          {/* 조합 */}
          {matrix.tooMany ? null : shown.length === 0 ? (
            <Empty>
              조건에 맞는 조합이 없습니다
              <Button
                variant="ghost"
                className="mx-auto mt-2"
                onClick={() => {
                  setFilter({})
                  pickStatus('')
                }}
              >
                거르기 풀기
              </Button>
            </Empty>
          ) : (
            <ul aria-label="조합" className="mt-1.5 flex flex-col gap-3">
              {groups.map((g) => {
                const value = groupAxis?.values.find((v) => v.id === g.id)
                const prog = groupAxis ? byValue.get(groupAxis.id)?.get(g.id) : undefined
                return (
                  <li key={g.id || 'all'} aria-label={value ? `${groupAxis!.name} ${value.label}` : undefined}>
                    {value && prog && (
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-semibold">{value.label}</span>
                        <span className="shrink-0 font-mono text-[11px] text-dim">
                          {prog.adopted}/{prog.target}
                        </span>
                        <ProgressBar className="ml-1 min-w-8 flex-1" value={prog.target ? prog.adopted / prog.target : 0} label={`${value.label} 진행률`} />
                        {prog.review > 0 && <span className="shrink-0 text-[11px] text-tag-meta">선별 {prog.review}</span>}
                      </div>
                    )}
                    <ul className={cx(grid ? 'grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2' : 'flex flex-col gap-1.5')}>
                      {g.combos.map((c) => (
                        <ComboCell
                          key={c.key}
                          item={p.items[c.key]}
                          combo={c}
                          grid={grid}
                          // 묶음 머리에 첫 축 값이 있으니 칸에는 나머지만
                          name={groupAxis ? c.picks.slice(1).map((x) => x.value.label).join(' · ') : c.label}
                          meta={metas.get(representativeOf(p.items[c.key])?.id ?? -1)}
                          onOpen={openCell}
                        />
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
          )}
          {shown.length > visible.length && (
            <Button variant="ghost" className="mt-2 w-full" onClick={() => setLimit((n) => n + PAGE)}>
              조합 {Math.min(PAGE, shown.length - visible.length)}개 더 보기 ({visible.length}/{shown.length})
            </Button>
          )}

          {orphans.length > 0 && (
            <section className="mt-5">
              <h3 className="text-xs text-dim">행렬에서 빠진 조합 (축 값을 지웠거나 껐거나 제외함 — 그림은 남아 있습니다)</h3>
              <ul className="mt-1.5 flex flex-col gap-1">
                {orphans.map((o) => (
                  <li key={o.key}>
                    <button
                      type="button"
                      onClick={() => setOpen({ key: o.key, review: false })}
                      className="flex h-11 w-full items-center gap-2 rounded-lg border border-line bg-field px-3 text-left text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">{orphanLabel(p, o.key)}</span>
                      <span className="text-xs text-dim">그림 {o.images.length}장</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line bg-panel p-3">
        <Button variant="default" onClick={() => setClassifying(true)}>
          <Tags size={16} />
          분류
        </Button>
        <Button variant="primary" className="flex-1" onClick={() => setPlanning({ mode: 'all' })}>
          <Play size={16} />
          생성 계획
        </Button>
      </div>
      {open !== null && (
        <CurationSheet
          key={open.key}
          project={p}
          itemKey={open.key}
          startReview={open.review}
          next={queue.length ? { key: queue[0], label: comboLabel(p, matrix.combos, queue[0]), left: queue.length } : undefined}
          onNext={(key) => setOpen({ key, review: true })}
          onClose={() => setOpen(null)}
        />
      )}
      {planning && (
        <PlanSheet
          project={p}
          selection={selection}
          initialMode={planning.mode}
          fillUnreviewed={planning.fill}
          initialScoped={!planning.whole}
          onClose={() => setPlanning(null)}
        />
      )}
      {classifying && <ClassifySheet project={p} onClose={() => setClassifying(false)} />}
    </div>
  )
}

function comboLabel(p: Project, combos: readonly Combination[], key: string): string {
  return combos.find((c) => c.key === key)?.label ?? orphanLabel(p, key)
}

/** 지워진 축·값이 섞인 조합 이름 */
export function orphanLabel(p: Project, key: string): string {
  const coords = parseComboKey(key)
  const axes = projectAxes(p)
  return Object.entries(coords)
    .map(([a, v]) => axes.find((x) => x.id === a)?.values.find((x) => x.id === v)?.label ?? '(지워진 값)')
    .join(' · ')
}

/** 조합 칸 — 바뀐 칸만 다시 그리도록 memo (항목은 바뀐 조합만 새 객체가 된다) */
const ComboCell = memo(function ComboCell(props: {
  item: AssetItem | undefined
  combo: Combination
  grid: boolean
  /** 칸에 쓸 이름 (묶음 머리에 있는 값은 뺀 것) */
  name: string
  meta: ReturnType<ReturnType<typeof useMetas>['get']>
  onOpen: (key: string) => void
}): ReactNode {
  const { combo, item } = props
  const onOpen = (): void => props.onOpen(combo.key)
  const status = itemStatus(item, combo.target)
  const c = curationCounts(item)
  const inFlight = (item?.queued ?? 0) + (item?.generating ?? 0)
  const hasRep = !!representativeOf(item)
  const label = `${combo.label}, ${ASSET_STATUS_LABEL[status]}, 채택 ${Math.min(c.adopted, combo.target)}/${combo.target}`
  const name = props.name || combo.label
  if (!props.grid) {
    return (
      <li>
        <button type="button" aria-label={label} onClick={onOpen} className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-panel p-1.5 pr-3 text-left">
          {hasRep ? <Thumb meta={props.meta} className="h-12 w-12 shrink-0 rounded-md" /> : <div className="h-12 w-12 shrink-0 rounded-md bg-raised" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{name}</div>
            <div className="text-[11px] text-dim">
              채택 {c.adopted}/{combo.target} · 그림 {c.total}
              {c.unreviewed ? ` · 미선별 ${c.unreviewed}` : ''}
              {inFlight ? ` · 대기 ${inFlight}` : ''}
              {item?.failed ? ` · 실패 ${item.failed}` : ''}
            </div>
          </div>
          <StatusBadge status={status} />
        </button>
      </li>
    )
  }
  return (
    <li>
      <button type="button" aria-label={label} onClick={onOpen} className="block w-full overflow-hidden rounded-lg border border-line bg-panel text-left">
        <div className="relative aspect-[3/4] w-full bg-raised">
          {hasRep && <Thumb meta={props.meta} className="absolute inset-0 h-full w-full" />}
          {!hasRep && status === 'pending' && (
            <span className="absolute inset-0 flex items-center justify-center text-[11px] text-dim/70">아직 없음</span>
          )}
          <span className="absolute left-1 top-1 rounded-full bg-black/75">
            <StatusBadge status={status} />
          </span>
          {inFlight > 0 && (
            <span className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] text-accent">+{inFlight}</span>
          )}
          {c.unreviewed > 0 && status === 'review' && (
            <span className="absolute bottom-1 left-1 rounded-full bg-black/70 px-1.5 text-[10px] text-tag-meta">미선별 {c.unreviewed}</span>
          )}
          <span className="absolute bottom-1 right-1 rounded-full bg-black/70 px-1.5 font-mono text-[10px] text-white">
            {c.adopted}/{combo.target}
          </span>
        </div>
        <div className="truncate px-1.5 py-1 text-xs">{name}</div>
      </button>
    </li>
  )
})
