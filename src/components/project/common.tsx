/** 에셋 프로젝트 화면들이 같이 쓰는 작은 부품 — 상태 배지, 진행 막대, 미루어 저장하는 입력, 히스토리 썸네일 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ImageOff } from 'lucide-react'
import * as db from '../../lib/db'
import { cx } from '../../lib/util'
import { ASSET_STATUS_LABEL, useProjects, type AssetStatus, type Project } from '../../project'
import { TextArea, TextInput } from '../ui'

type ProjectPatch = Parameters<ReturnType<typeof useProjects.getState>['patch']>[1]

/**
 * 저장소에 있는 지금의 프로젝트로 고칠 내용을 만든다 (null이면 그대로). 렌더할 때의 프로젝트로 배열·객체를 통째로
 * 덮어쓰면, 그 사이에 바뀐 것(방금 지운 규칙 등)이 되살아나거나 다른 칸의 수정이 사라진다 — 특히 DraftInput이
 * 화면을 떠나며 남은 글을 늦게 저장할 때
 */
export function patchLatest(projectId: string, fn: (latest: Project) => ProjectPatch | null): void {
  const s = useProjects.getState()
  const latest = s.projects.find((x) => x.id === projectId)
  if (!latest) return
  const patch = fn(latest)
  if (patch) s.patch(projectId, patch)
}

export const STATUS_STYLE: Record<AssetStatus, string> = {
  pending: 'bg-raised text-dim',
  queued: 'bg-accent/15 text-accent',
  generating: 'bg-accent text-accent-fg',
  review: 'bg-tag-meta/20 text-tag-meta',
  adopted: 'bg-ok/20 text-ok',
  redo: 'bg-danger/15 text-danger',
  exported: 'bg-ok text-black'
}

export function StatusBadge(props: { status: AssetStatus; className?: string }): ReactNode {
  return (
    <span className={cx('inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium', STATUS_STYLE[props.status], props.className)}>
      {ASSET_STATUS_LABEL[props.status]}
    </span>
  )
}

export function ProgressBar(props: { value: number; className?: string; label?: string }): ReactNode {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100)
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx('h-1.5 overflow-hidden rounded-full bg-raised', props.className)}
    >
      <div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  )
}

/** 이름표가 붙은 입력 묶음 */
export function Field(props: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={cx('flex flex-col gap-1 text-xs text-dim', props.className)}>
      <span>{props.label}</span>
      {props.children}
      {props.hint && <span className="text-[11px] text-dim/80">{props.hint}</span>}
    </div>
  )
}

/** 글을 칠 때마다 저장(localStorage 직렬화)하지 않고, 잠깐 멈추거나 떠날 때 반영한다 */
function useDraft(value: string, commit: (v: string) => void, delay = 500): [string, (v: string) => void] {
  const [draft, setDraft] = useState(value)
  const last = useRef(value)
  const commitRef = useRef(commit)
  commitRef.current = commit
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string | null>(null)
  // 밖에서 바뀐 값(다른 화면·되돌리기)을 따라간다
  useEffect(() => {
    if (value !== last.current && pending.current === null) setDraft(value)
    last.current = value
  }, [value])
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      if (pending.current !== null) commitRef.current(pending.current)
    },
    []
  )
  const set = (v: string): void => {
    setDraft(v)
    pending.current = v
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      pending.current = null
      last.current = v
      commitRef.current(v)
    }, delay)
  }
  return [draft, set]
}

export function DraftInput(props: {
  label: string
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  className?: string
  inputMode?: 'numeric' | 'text'
}): ReactNode {
  const [v, set] = useDraft(props.value, props.onCommit)
  return (
    <TextInput label={props.label} value={v} onChange={set} placeholder={props.placeholder} className={props.className} inputMode={props.inputMode} />
  )
}

export function DraftArea(props: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string; rows?: number }): ReactNode {
  const [v, set] = useDraft(props.value, props.onCommit)
  return <TextArea label={props.label} value={v} onChange={set} placeholder={props.placeholder} rows={props.rows ?? 3} />
}

/** 숫자 칸 — 바로 반영하되 비우거나 범위를 벗어나면 떠날 때 되돌린다 */
export function NumberInput(props: {
  label: string
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number
  className?: string
  placeholder?: string
}): ReactNode {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const parse = (t: string): number | null => {
    const n = Number(t)
    if (t.trim() === '' || !Number.isFinite(n)) return null
    if (props.min !== undefined && n < props.min) return null
    if (props.max !== undefined && n > props.max) return null
    return n
  }
  return (
    <input
      aria-label={props.label}
      inputMode="decimal"
      value={text}
      placeholder={props.placeholder}
      onChange={(e) => {
        setText(e.target.value)
        const n = parse(e.target.value)
        if (n !== null && n !== props.value) props.onCommit(n)
      }}
      onBlur={() => {
        if (parse(text) === null) setText(String(props.value))
      }}
      className={cx('h-11 w-24 rounded-lg border border-line bg-field px-3 text-right font-mono text-sm tabular-nums text-fg', props.className)}
    />
  )
}

/** 여러 개 중 하나 (라디오) */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  className?: string
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={props.label} className={cx('flex rounded-lg border border-line bg-field p-0.5', props.className)}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={cx(
            'h-10 min-w-0 flex-1 truncate rounded-md px-2 text-[13px]',
            props.value === o.value ? 'bg-raised font-semibold text-fg' : 'text-dim'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 켜고 끄는 작은 칩 */
export function Chip(props: { on: boolean; onClick: () => void; children: ReactNode; label?: string; className?: string }): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      aria-label={props.label}
      onClick={props.onClick}
      className={cx(
        'flex h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-xs',
        props.on ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim',
        props.className
      )}
    >
      {props.children}
    </button>
  )
}

// ── 히스토리 썸네일 ─────────────────────────────────────────────────────────

/** 이미 읽은 히스토리 meta (id → meta). 지운 그림은 프로젝트가 forgetImages로 빼므로 따로 비우지 않는다 */
const metaCache = new Map<number, db.HistoryMeta | null>()
const inflight = new Map<number, Promise<void>>()

async function loadMetas(ids: number[]): Promise<void> {
  const want = ids.filter((id) => !metaCache.has(id) && !inflight.has(id))
  if (!want.length) {
    await Promise.all(ids.map((id) => inflight.get(id)))
    return
  }
  const p = db
    .getMetas(want)
    .then((metas) => {
      const found = new Map(metas.map((m) => [m.id, m]))
      for (const id of want) metaCache.set(id, found.get(id) ?? null)
    })
    .catch(() => {
      for (const id of want) metaCache.set(id, null)
    })
    .finally(() => {
      for (const id of want) inflight.delete(id)
    })
  for (const id of want) inflight.set(id, p)
  await Promise.all([p, ...ids.map((id) => inflight.get(id))])
}

/** id들의 히스토리 meta — 프로젝트에 기록된 id로만 읽는다 (히스토리 전체를 훑지 않음) */
export function useMetas(ids: readonly number[]): Map<number, db.HistoryMeta | null> {
  const key = ids.join(',')
  const [, bump] = useState(0)
  useEffect(() => {
    let live = true
    const list = key ? key.split(',').map(Number) : []
    if (list.every((id) => metaCache.has(id))) return
    void loadMetas(list).then(() => live && bump((n) => n + 1))
    return () => {
      live = false
    }
  }, [key])
  const out = new Map<number, db.HistoryMeta | null>()
  for (const id of ids) if (metaCache.has(id)) out.set(id, metaCache.get(id) ?? null)
  return out
}

/** 분류로 태그를 붙였을 때처럼 meta가 바뀌면 캐시도 바꾼다 */
export function rememberMeta(meta: db.HistoryMeta): void {
  metaCache.set(meta.id, meta)
}

export function Thumb(props: { meta: db.HistoryMeta | null | undefined; className?: string; alt?: string }): ReactNode {
  const [broken, setBroken] = useState(false)
  const m = props.meta
  if (m === null || broken || (m && !m.thumb)) {
    return (
      <div className={cx('flex items-center justify-center bg-raised text-dim', props.className)} aria-label={m === null ? '히스토리에 없는 그림' : undefined}>
        <ImageOff size={18} />
      </div>
    )
  }
  if (!m) return <div className={cx('animate-pulse bg-raised', props.className)} />
  return (
    <img
      src={m.thumb}
      alt={props.alt ?? ''}
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
      className={cx('object-cover', props.className)}
    />
  )
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
