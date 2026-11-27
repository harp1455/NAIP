/** 행렬 — 조합마다 상태·대표 그림·채택/목표, 축 값·상태로 거르기, 합계. 누르면 선별 화면 */
import { useMemo, useState, type ReactNode } from 'react'
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
  projectAxes,
  representativeOf,
  type AssetStatus,
  type Combination,
  type MatrixSelection,
  type Project
} from '../../project'
import { Button, Empty, Select } from '../ui'
import { ProgressBar, StatusBadge, STATUS_STYLE, Thumb, useMetas } from './common'
import { CurationSheet } from './CurationSheet'
import { PlanSheet } from './PlanSheet'
import { ClassifySheet } from './ClassifySheet'

const STATUSES = Object.keys(ASSET_STATUS_LABEL) as AssetStatus[]

export function MatrixView(props: { project: Project; onEdit: () => void }): ReactNode {
  const p = props.project
  const matrix = useMemo(() => expandMatrix(p), [p])
  const totals = useMemo(() => matrixTotals(p, matrix), [p, matrix])
  const orphans = useMemo(() => orphanItems(p), [p])
  const axes = useMemo(() => projectAxes(p), [p])
  const [filter, setFilter] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<AssetStatus | ''>('')
  const [grid, setGrid] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const [classifying, setClassifying] = useState(false)

  const shown = matrix.combos.filter(
    (c) =>
      Object.entries(filter).every(([a, v]) => !v || c.coords[a] === v) &&
      (!status || itemStatus(p.items[c.key], c.target) === status)
  )
  const reps = shown.map((c) => representativeOf(p.items[c.key])?.id).filter((id): id is number => id !== undefined)
  const metas = useMetas(reps)
  const selection: MatrixSelection | undefined = Object.values(filter).some(Boolean)
    ? { values: Object.fromEntries(Object.entries(filter).filter(([, v]) => v).map(([a, v]) => [a, [v]])) }
    : undefined

  if (!matrix.combos.length && !matrix.tooMany) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Empty>
          {matrix.warnings.map((w) => (
            <span key={w.message} className="block">
              {w.message}
            </span>
          ))}
          <Button variant="primary" className="mx-auto mt-4" onClick={props.onEdit}>
            설정으로 가기
          </Button>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-3">
          {/* 합계 */}
          <section aria-label="합계" className="rounded-xl border border-line bg-panel p-3">
            <div className="flex items-baseline gap-2 text-sm">
              <span className="font-semibold">
                채택 {totals.adopted}/{totals.target}
              </span>
              <span className="text-xs text-dim">
                조합 {totals.combos}개{totals.excluded ? ` (제외 ${totals.excluded})` : ''} · 전체 생성 {totals.images}장
              </span>
              <span className="ml-auto font-mono text-xs text-dim">{Math.round(totals.progress * 100)}%</span>
            </div>
            <ProgressBar className="mt-2" value={totals.progress} label="채택 진행률" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STATUSES.filter((s) => totals.byStatus[s]).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={status === s}
                  onClick={() => setStatus(status === s ? '' : s)}
                  className={cx('h-7 rounded-full px-2.5 text-[11px]', STATUS_STYLE[s], status === s && 'ring-2 ring-fg')}
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
          </section>

          {/* 거르기 */}
          <div className="scroll-thin mt-3 flex items-center gap-1.5 overflow-x-auto pb-1" role="group" aria-label="거르기">
            {axes.map((a) => (
              <Select
                key={a.id}
                label={`${a.name} 거르기`}
                className="w-32 shrink-0 sm:w-40"
                value={filter[a.id] ?? ''}
                options={[{ value: '', label: `모든 ${a.name}` }, ...a.values.filter((v) => v.enabled !== false).map((v) => ({ value: v.id, label: v.label }))]}
                onChange={(v) => setFilter({ ...filter, [a.id]: v })}
              />
            ))}
            <Select
              label="상태 거르기"
              className="w-32 shrink-0 sm:w-40"
              value={status}
              options={[{ value: '' as const, label: '모든 상태' }, ...STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_LABEL[s] }))]}
              onChange={(v) => setStatus(v)}
            />
            <div className="ml-auto flex shrink-0">
              <button
                type="button"
                aria-label="격자로 보기"
                aria-pressed={grid}
                onClick={() => setGrid(true)}
                className={cx('flex h-10 w-10 items-center justify-center rounded-lg', grid ? 'bg-raised text-fg' : 'text-dim')}
              >
                <LayoutGrid size={17} />
              </button>
              <button
                type="button"
                aria-label="목록으로 보기"
                aria-pressed={!grid}
                onClick={() => setGrid(false)}
                className={cx('flex h-10 w-10 items-center justify-center rounded-lg', !grid ? 'bg-raised text-fg' : 'text-dim')}
              >
                <List size={17} />
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-dim">
            {shown.length === matrix.combos.length ? `조합 ${shown.length}개` : `조합 ${shown.length}/${matrix.combos.length}개 표시`}
          </p>

          {/* 조합 */}
          {shown.length === 0 ? (
            <Empty>조건에 맞는 조합이 없습니다</Empty>
          ) : (
            <ul
              aria-label="조합"
              className={cx('mt-2', grid ? 'grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2' : 'flex flex-col gap-1.5')}
            >
              {shown.map((c) => (
                <ComboCell key={c.key} project={p} combo={c} grid={grid} meta={metas.get(representativeOf(p.items[c.key])?.id ?? -1)} onOpen={() => setOpen(c.key)} />
              ))}
            </ul>
          )}

          {orphans.length > 0 && (
            <section className="mt-5">
              <h3 className="text-xs text-dim">행렬에서 빠진 조합 (축 값을 지웠거나 껐거나 제외함 — 그림은 남아 있습니다)</h3>
              <ul className="mt-1.5 flex flex-col gap-1">
                {orphans.map((o) => (
                  <li key={o.key}>
                    <button type="button" onClick={() => setOpen(o.key)} className="flex h-11 w-full items-center gap-2 rounded-lg border border-line bg-field px-3 text-left text-sm">
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
        <Button variant="primary" className="flex-1" onClick={() => setPlanning(true)}>
          <Play size={16} />
          생성 계획
        </Button>
      </div>
      {open !== null && <CurationSheet project={p} itemKey={open} onClose={() => setOpen(null)} />}
      {planning && <PlanSheet project={p} selection={selection} onClose={() => setPlanning(false)} />}
      {classifying && <ClassifySheet project={p} onClose={() => setClassifying(false)} />}
    </div>
  )
}

/** 지워진 축·값이 섞인 조합 이름 */
export function orphanLabel(p: Project, key: string): string {
  const coords = parseComboKey(key)
  const axes = projectAxes(p)
  return Object.entries(coords)
    .map(([a, v]) => axes.find((x) => x.id === a)?.values.find((x) => x.id === v)?.label ?? '(지워진 값)')
    .join(' · ')
}

function ComboCell(props: { project: Project; combo: Combination; grid: boolean; meta: ReturnType<ReturnType<typeof useMetas>['get']>; onOpen: () => void }): ReactNode {
  const { combo } = props
  const item = props.project.items[combo.key]
  const status = itemStatus(item, combo.target)
  const c = curationCounts(item)
  const inFlight = (item?.queued ?? 0) + (item?.generating ?? 0)
  const hasRep = !!representativeOf(item)
  const label = `${combo.label}, ${ASSET_STATUS_LABEL[status]}, 채택 ${Math.min(c.adopted, combo.target)}/${combo.target}`
  if (!props.grid) {
    return (
      <li>
        <button type="button" aria-label={label} onClick={props.onOpen} className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-panel p-1.5 pr-3 text-left">
          {hasRep ? <Thumb meta={props.meta} className="h-12 w-12 shrink-0 rounded-md" /> : <div className="h-12 w-12 shrink-0 rounded-md bg-raised" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{combo.label}</div>
            <div className="text-[11px] text-dim">
              채택 {c.adopted}/{combo.target} · 그림 {c.total}
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
      <button type="button" aria-label={label} onClick={props.onOpen} className="block w-full overflow-hidden rounded-lg border border-line bg-panel text-left">
        <div className="relative aspect-[3/4] w-full bg-raised">
          {hasRep && <Thumb meta={props.meta} className="absolute inset-0 h-full w-full" />}
          <span className="absolute left-1 top-1 rounded-full bg-black/75">
            <StatusBadge status={status} />
          </span>
          {inFlight > 0 && (
            <span className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] text-accent">+{inFlight}</span>
          )}
          <span className="absolute bottom-1 right-1 rounded-full bg-black/70 px-1.5 font-mono text-[10px] text-white">
            {c.adopted}/{combo.target}
          </span>
        </div>
        <div className="truncate px-1.5 py-1 text-[11px]">{combo.label}</div>
      </button>
    </li>
  )
}
