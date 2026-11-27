/**
 * 분류 — 프로젝트 밖에서 만든 히스토리 그림을 프롬프트·씬·캐릭터 이름(+ 분류 규칙)으로 조합에 배정한다.
 * 결과를 보여 주고 사용자가 고른 것만 배정한다 (모호하거나 못 찾은 그림은 직접 조합을 고를 수 있다). 아무것도 지우지 않는다.
 */
import { useMemo, useState, type ReactNode } from 'react'
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
  type Project,
  type ProjectImageTag
} from '../../project'
import { toast } from '../../stores/toast'
import { Button, Empty, IconButton, Row, Select, Sheet, Toggle } from '../ui'
import { DraftInput, Field, rememberMeta, Thumb } from './common'

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

  const known = useMemo(() => new Set(Object.values(p.items).flatMap((i) => i.images.map((img) => img.id))), [p])

  const scan = async (): Promise<void> => {
    setBusy(true)
    try {
      const metas = await db.listMeta(limit)
      // 지운 프로젝트의 분류 표시는 없는 것으로 본다 (다른 프로젝트에 다시 배정할 수 있게)
      const liveProjects = new Set(useProjects.getState().projects.map((x) => x.id))
      let tagged = 0
      let inProject = 0
      const out: Found[] = []
      for (const m of metas) {
        if (known.has(m.id)) {
          inProject++
          continue
        }
        if (m.project && liveProjects.has(m.project.projectId)) {
          tagged++
          continue
        }
        out.push({ meta: m, result: classify(p, inputOf(m), { useFragments }) })
      }
      setSkipped({ tagged, inProject })
      setFound(out)
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
      const byId = new Map(found.map((f) => [f.meta.id, f.meta]))
      for (const [idText, key] of picked) {
        const meta = byId.get(Number(idText))
        const combo = combos.find((c) => c.key === key)
        if (!meta || !combo) continue
        const tag: ProjectImageTag = { projectId: p.id, key, coords: combo.coords }
        // 히스토리에 분류 표시를 남긴다 (원본은 그대로)
        const next = { ...meta, project: tag }
        await db.putMeta(next)
        rememberMeta(next)
        s.addImage(p.id, key, { id: meta.id, ts: meta.ts, seed: meta.seed, width: meta.width, height: meta.height, mime: meta.mime }, { fromQueue: false })
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
                {matched.map((f) => (
                  <FoundRow key={f.meta.id} f={f} combos={combos} value={choice[f.meta.id] ?? ''} onChange={(k) => setChoice({ ...choice, [f.meta.id]: k })} />
                ))}
              </ul>
            </section>
          )}
          {unsure.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold">확인 필요 — 모호하거나 못 찾은 축이 있습니다. 직접 조합을 고르면 배정합니다</h3>
              <ul className="flex flex-col gap-1.5">
                {unsure.slice(0, 200).map((f) => (
                  <FoundRow
                    key={f.meta.id}
                    f={f}
                    combos={combos}
                    value={choice[f.meta.id] ?? ''}
                    note={[
                      ...f.result.ambiguous.map((a) => `${axisName(a)}: 둘 이상 맞음`),
                      ...f.result.missing.map((a) => `${axisName(a)}: 못 찾음`),
                      ...(!f.result.missing.length && !f.result.ambiguous.length ? ['제외된 조합'] : [])
                    ].join(' · ')}
                    onChange={(k) => setChoice({ ...choice, [f.meta.id]: k })}
                  />
                ))}
              </ul>
              {unsure.length > 200 && <p className="mt-1 text-xs text-dim">처음 200장만 보입니다</p>}
            </section>
          )}
        </div>
      )}
    </Sheet>
  )
}

function FoundRow(props: {
  f: Found
  combos: ReturnType<typeof expandMatrix>['combos']
  value: string
  note?: string
  onChange: (key: string) => void
}): ReactNode {
  const { meta, result } = props.f
  const guess = result.tag ? props.combos.find((c) => c.key === result.tag!.key) : null
  return (
    <li className={cx('flex items-center gap-2 rounded-lg border bg-field p-1.5', props.value ? 'border-accent' : 'border-line')}>
      <Thumb meta={meta} className="h-14 w-11 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-dim">{(meta.sent?.prompt ?? meta.prompt).slice(0, 120)}</div>
        {props.note && <div className="text-[11px] text-tag-meta">{props.note}</div>}
        <Select
          label={`seed ${meta.seed} 배정할 조합`}
          className="mt-1"
          value={props.value}
          options={[{ value: '', label: guess ? `배정 안 함 (추정: ${guess.label})` : '배정 안 함' }, ...props.combos.map((c) => ({ value: c.key, label: c.label }))]}
          onChange={props.onChange}
        />
      </div>
    </li>
  )
}

/** 분류 규칙 — 축 값마다 "이 글자들이 모두 있으면" */
function RulesEditor(props: { project: Project }): ReactNode {
  const p = props.project
  const axes = projectAxes(p)
  const set = (rules: ClassificationRule[]): void => useProjects.getState().patch(p.id, { rules })
  const first = axes[0]
  return (
    <section>
      <div className="flex items-center">
        <h3 className="flex-1 text-xs font-semibold">분류 규칙 {p.rules.length ? `${p.rules.length}개` : ''}</h3>
        <Button
          variant="ghost"
          className="px-2 text-xs"
          disabled={!first?.values.length}
          onClick={() => set([...p.rules, { id: newId(), axisId: first.id, valueId: first.values[0].id, match: '', field: 'prompt' }])}
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
            const patch = (x: Partial<ClassificationRule>): void => set(p.rules.map((y) => (y.id === r.id ? { ...y, ...x } : y)))
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
                  <IconButton label="규칙 삭제" onClick={() => set(p.rules.filter((y) => y.id !== r.id))}>
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
