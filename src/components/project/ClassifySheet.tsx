/**
 * 분류 — 프로젝트 밖에서 만든 히스토리 그림을 프롬프트·씬·캐릭터 이름(+ 분류 규칙)으로 조합에 배정한다.
 * 결과를 보여 주고 사용자가 고른 것만 배정한다 (모호하거나 못 찾은 그림은 직접 조합을 고를 수 있다). 아무것도 지우지 않는다.
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import * as db from '../../lib/db'
import { cx } from '../../lib/util'
import {
  classify,
  expandMatrix,
  newId,
  projectAxes,
  useProjects,
  type ClassificationRule,
  type ClassifyResult,
  type Combination,
  type Project,
  type ProjectImageTag
} from '../../project'
import { tagHistoryImages } from '../../project/assign'
import { toast } from '../../stores/toast'
import { Button, Empty, IconButton, Row, Select, Sheet, Toggle } from '../ui'
import { DraftInput, Field, patchLatest, rememberMeta, Thumb } from './common'

/** 한 번에 그리는 줄 수 — 수천 장을 살펴봐도 화면이 멈추지 않게 "더 보기"로 늘린다 */
const PAGE = 100

interface Found {
  meta: db.HistoryMeta
  result: ClassifyResult
}

const FIELD_OPTIONS: { value: ClassificationRule['field']; label: string }[] = [
  { value: 'prompt', label: '프롬프트' },
  { value: 'scene', label: '씬 이름' },
  { value: 'character', label: '캐릭터 이름' },
  { value: 'any', label: '어디든' }
]

/** 히스토리 meta → 분류 입력 (보낸 내용 우선) */
function inputOf(m: db.HistoryMeta): Parameters<typeof classify>[1] {
  return {
    prompt: m.sent?.prompt ?? m.prompt,
    ...(m.sceneName ? { sceneName: m.sceneName } : {}),
    characterNames: (m.sent?.chars ?? m.snap?.chars ?? []).map((c) => c.name).filter(Boolean),
    characterPrompts: (m.sent?.chars ?? m.snap?.chars ?? []).map((c) => c.prompt)
  }
}

export function ClassifySheet(props: { project: Project; onClose: () => void }): ReactNode {
  const p = props.project
  const s = useProjects.getState()
  const axes = useMemo(() => projectAxes(p), [p])
  const combos = useMemo(() => expandMatrix(p).combos, [p])
  const [limit, setLimit] = useState(300)
  const [useFragments, setUseFragments] = useState(true)
  const [found, setFound] = useState<Found[] | null>(null)
  const [skipped, setSkipped] = useState({ tagged: 0, inProject: 0 })
  const [busy, setBusy] = useState(false)
  /** 이미지 id → 배정할 조합 키 ('' = 배정 안 함) */
  const [choice, setChoice] = useState<Record<number, string>>({})
  /** 조합 고르기를 연 줄 (한 번에 한 줄만 — 줄마다 조합 전체 목록을 그리지 않게) */
  const [editing, setEditing] = useState<number | null>(null)
  const [shownMatched, setShownMatched] = useState(PAGE)
  const [shownUnsure, setShownUnsure] = useState(PAGE)
  const labels = useMemo(() => new Map(combos.map((c) => [c.key, c.label])), [combos])
  const pick = useCallback((id: number, key: string) => {
    setChoice((c) => ({ ...c, [id]: key }))
    setEditing(null)
  }, [])

  const known = useMemo(() => new Set(Object.values(p.items).flatMap((i) => i.images.map((img) => img.id))), [p])

  const scan = async (): Promise<void> => {
    setBusy(true)
    try {
      const metas = await db.listMeta(limit)
      let tagged = 0
      let inProject = 0
      const out: Found[] = []
      for (const m of metas) {
        if (known.has(m.id)) {
          inProject++
          continue
        }
        if (m.project) {
          tagged++
          continue
        }
        out.push({ meta: m, result: classify(p, inputOf(m), { useFragments }) })
      }
      setSkipped({ tagged, inProject })
      setFound(out)
      setEditing(null)
      setShownMatched(PAGE)
      setShownUnsure(PAGE)
      setChoice(Object.fromEntries(out.filter((f) => f.result.tag).map((f) => [f.meta.id, f.result.tag!.key])))
    } finally {
      setBusy(false)
    }
  }

  const matched = found?.filter((f) => f.result.tag) ?? []
  const unsure = found?.filter((f) => !f.result.tag) ?? []
  const picked = Object.entries(choice).filter(([, k]) => k)
  const axisName = (id: string): string => axes.find((a) => a.id === id)?.name ?? id

  const apply = async (): Promise<void> => {
    if (!found) return
    setBusy(true)
    let n = 0
    try {
      const byKey = new Map(combos.map((c) => [c.key, c]))
      const picks: { id: number; tag: ProjectImageTag }[] = []
      for (const [idText, key] of picked) {
        const combo = byKey.get(key)
        if (combo) picks.push({ id: Number(idText), tag: { projectId: p.id, key, coords: combo.coords } })
      }
      // 히스토리에 분류 표시를 남긴다 (원본은 그대로, 쓰기 직전의 meta에 표시만 더함)
      for (const meta of await tagHistoryImages(picks)) {
        rememberMeta(meta)
        s.addImage(p.id, meta.project!.key, { id: meta.id, ts: meta.ts, seed: meta.seed, width: meta.width, height: meta.height, mime: meta.mime }, { fromQueue: false })
        n++
      }
    } finally {
      setBusy(false)
    }
    toast(`${n}장을 조합에 배정했습니다 — 선별 화면에서 "미선별"로 보입니다`)
    props.onClose()
  }

  return (
    <Sheet
      title="히스토리에서 분류"
      onClose={props.onClose}
      footer={
        found ? (
          <>
            <Button variant="ghost" onClick={() => setFound(null)}>
              다시 찾기
            </Button>
            <Button variant="primary" className="flex-1" disabled={!picked.length || busy} onClick={() => void apply()}>
              {picked.length}장 배정
            </Button>
          </>
        ) : (
          <Button variant="primary" className="flex-1" disabled={busy || !combos.length} onClick={() => void scan()}>
            <Search size={16} />
            {busy ? '찾는 중…' : `최근 ${limit}장 살펴보기`}
          </Button>
        )
      }
    >
      {!found ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-dim">
            프로젝트로 만들지 않은 그림을 프롬프트로 조합에 배정합니다. 캐릭터는 보낸 캐릭터 이름으로, 다른 축은 아래 규칙(또는 값의 프롬프트
            조각)으로 찾습니다. 결과를 확인한 뒤 고른 것만 배정하며, 히스토리의 그림은 지우거나 바꾸지 않습니다 (분류 표시만 붙습니다).
          </p>
          <div className="rounded-lg border border-line bg-field px-3">
            <Row label="살펴볼 장수" hint="최신 그림부터">
              <Select
                label="살펴볼 장수"
                className="w-28"
                value={limit}
                options={[100, 300, 1000, 5000].map((v) => ({ value: v, label: `${v}장` }))}
                onChange={setLimit}
              />
            </Row>
            <Row label="값의 프롬프트 조각으로도 찾기" hint="규칙이 없는 축은 값의 프롬프트가 통째로 들어 있으면 그 값">
              <Toggle label="값의 프롬프트 조각으로도 찾기" checked={useFragments} onChange={setUseFragments} />
            </Row>
          </div>
          <RulesEditor project={p} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-dim">
            {found.length}장 중 배정 가능 {matched.length} · 확인 필요 {unsure.length}
            {skipped.inProject ? ` · 이미 이 프로젝트 ${skipped.inProject}` : ''}
            {skipped.tagged ? ` · 다른 프로젝트에 배정됨 ${skipped.tagged}` : ''}
          </p>
          {found.length === 0 && <Empty>살펴볼 그림이 없습니다</Empty>}
          {matched.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold">배정 가능 — 체크를 풀면 배정하지 않습니다</h3>
              <ul className="flex flex-col gap-1.5">
                {matched.slice(0, shownMatched).map((f) => (
                  <FoundRow
                    key={f.meta.id}
                    f={f}
                    value={choice[f.meta.id] ?? ''}
                    valueLabel={labels.get(choice[f.meta.id] ?? '') ?? null}
                    guessLabel={labels.get(f.result.tag!.key) ?? null}
                    combos={editing === f.meta.id ? combos : null}
                    onEdit={setEditing}
                    onChange={pick}
                  />
                ))}
              </ul>
              {matched.length > shownMatched && (
                <Button variant="ghost" className="mt-1 w-full" onClick={() => setShownMatched((n) => n + PAGE)}>
                  {matched.length - shownMatched}장 더 보기
                </Button>
              )}
            </section>
          )}
          {unsure.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold">확인 필요 — 모호하거나 못 찾은 축이 있습니다. 직접 조합을 고르면 배정합니다</h3>
              <ul className="flex flex-col gap-1.5">
                {unsure.slice(0, shownUnsure).map((f) => (
                  <FoundRow
                    key={f.meta.id}
                    f={f}
                    value={choice[f.meta.id] ?? ''}
                    valueLabel={labels.get(choice[f.meta.id] ?? '') ?? null}
                    guessLabel={null}
                    combos={editing === f.meta.id ? combos : null}
                    note={[
                      ...f.result.ambiguous.map((a) => `${axisName(a)}: 둘 이상 맞음`),
                      ...f.result.missing.map((a) => `${axisName(a)}: 못 찾음`),
                      ...(!f.result.missing.length && !f.result.ambiguous.length ? ['제외된 조합'] : [])
                    ].join(' · ')}
                    onEdit={setEditing}
                    onChange={pick}
                  />
                ))}
              </ul>
              {unsure.length > shownUnsure && (
                <Button variant="ghost" className="mt-1 w-full" onClick={() => setShownUnsure((n) => n + PAGE)}>
                  {unsure.length - shownUnsure}장 더 보기
                </Button>
              )}
            </section>
          )}
        </div>
      )}
    </Sheet>
  )
}

/**
 * 살펴본 그림 한 줄 — 조합 목록(select)은 "바꾸기"를 누른 줄에만 그린다 (수백 줄 × 수백 조합의 option을 한꺼번에
 * 그리면 시트가 멈춘다). 바뀐 줄만 다시 그리도록 memo
 */
const FoundRow = memo(function FoundRow(props: {
  f: Found
  value: string
  valueLabel: string | null
  guessLabel: string | null
  /** 이 줄에서 조합을 고르는 중이면 조합 목록 */
  combos: readonly Combination[] | null
  note?: string
  onEdit: (id: number | null) => void
  onChange: (id: number, key: string) => void
}): ReactNode {
  const { meta } = props.f
  return (
    <li className={cx('flex items-center gap-2 rounded-lg border bg-field p-1.5', props.value ? 'border-accent' : 'border-line')}>
      <Thumb meta={meta} className="h-14 w-11 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-dim">{(meta.sent?.prompt ?? meta.prompt).slice(0, 120)}</div>
        {props.note && <div className="text-[11px] text-tag-meta">{props.note}</div>}
        {props.combos ? (
          <Select
            label={`seed ${meta.seed} 배정할 조합`}
            className="mt-1"
            value={props.value}
            options={[
              { value: '', label: props.guessLabel ? `배정 안 함 (추정: ${props.guessLabel})` : '배정 안 함' },
              ...props.combos.map((c) => ({ value: c.key, label: c.label }))
            ]}
            onChange={(k) => props.onChange(meta.id, k)}
          />
        ) : (
          <div className="mt-1 flex items-center gap-1.5">
            <span className={cx('min-w-0 flex-1 truncate text-xs', props.value ? 'text-fg' : 'text-dim')}>
              {props.value ? `→ ${props.valueLabel ?? '?'}` : props.guessLabel ? `배정 안 함 (추정: ${props.guessLabel})` : '배정 안 함'}
            </span>
            {props.value ? (
              <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => props.onChange(meta.id, '')}>
                빼기
              </Button>
            ) : null}
            <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => props.onEdit(meta.id)}>
              바꾸기
            </Button>
          </div>
        )}
      </div>
    </li>
  )
})

/** 분류 규칙 — 축 값마다 "이 글자들이 모두 있으면" */
function RulesEditor(props: { project: Project }): ReactNode {
  const p = props.project
  const axes = projectAxes(p)
  // 렌더할 때의 목록이 아니라 지금 저장된 목록을 고친다 — 지운 규칙의 입력칸이 남은 글을 늦게 저장하며 규칙을 되살리지 않게
  const set = (fn: (rules: ClassificationRule[]) => ClassificationRule[] | null): void =>
    patchLatest(p.id, (latest) => {
      const rules = fn(latest.rules)
      return rules ? { rules } : null
    })
  const first = axes[0]
  return (
    <section>
      <div className="flex items-center">
        <h3 className="flex-1 text-xs font-semibold">분류 규칙 {p.rules.length ? `${p.rules.length}개` : ''}</h3>
        <Button
          variant="ghost"
          className="px-2 text-xs"
          disabled={!first?.values.length}
          onClick={() => set((rules) => [...rules, { id: newId(), axisId: first.id, valueId: first.values[0].id, match: '', field: 'prompt' }])}
        >
          <Plus size={14} />
          규칙 추가
        </Button>
      </div>
      {p.rules.length === 0 ? (
        <p className="text-[11px] text-dim">규칙이 없으면 캐릭터 이름과 값의 프롬프트 조각으로만 찾습니다</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {p.rules.map((r) => {
            const axis = axes.find((a) => a.id === r.axisId) ?? first
            const patch = (x: Partial<ClassificationRule>): void =>
              set((rules) => (rules.some((y) => y.id === r.id) ? rules.map((y) => (y.id === r.id ? { ...y, ...x } : y)) : null))
            return (
              <li key={r.id} className="rounded-lg border border-line bg-field p-2">
                <div className="flex gap-1.5">
                  <Select
                    label="규칙의 축"
                    className="flex-1"
                    value={r.axisId}
                    options={axes.map((a) => ({ value: a.id, label: a.name }))}
                    onChange={(axisId) => patch({ axisId, valueId: axes.find((a) => a.id === axisId)?.values[0]?.id ?? '' })}
                  />
                  <Select
                    label="규칙의 값"
                    className="flex-1"
                    value={r.valueId}
                    options={(axis?.values ?? []).map((v) => ({ value: v.id, label: v.label }))}
                    onChange={(valueId) => patch({ valueId })}
                  />
                  <IconButton
                    label="규칙 삭제"
                    onClick={() => {
                      if (window.confirm('이 분류 규칙을 지울까요?')) set((rules) => rules.filter((y) => y.id !== r.id))
                    }}
                  >
                    <Trash2 size={16} className="text-danger" />
                  </IconButton>
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <Field label="이 글자가 모두 있으면 (쉼표로 여러 개)" className="flex-1">
                    <DraftInput label="규칙 글자" value={r.match} placeholder="smile, open mouth" onCommit={(match) => patch({ match })} />
                  </Field>
                  <Field label="찾을 곳" className="w-28">
                    <Select label="찾을 곳" value={r.field} options={FIELD_OPTIONS} onChange={(field) => patch({ field })} />
                  </Field>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
