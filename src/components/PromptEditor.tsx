import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardPaste, Eraser, Undo2, X } from 'lucide-react'
import { readClipboard } from '../lib/native'
import { highlightRanges } from '../nai/weights'
import { formatCount, searchTags, type TagCategory, type TagHit, type TagSourceSetting } from '../lib/tags'
import { cx } from '../lib/util'
import { useSettings } from '../stores/settings'

const SOURCE_CYCLE: TagSourceSetting[] = ['both', 'danbooru', 'e621']
const SOURCE_LABEL: Record<TagSourceSetting, string> = {
  both: '전체',
  danbooru: '단부루',
  e621: 'e621',
  off: '끔'
}
const CATEGORY_CLASS: Record<TagCategory, string> = {
  g: 'text-fg',
  a: 'text-tag-artist',
  c: 'text-tag-character',
  s: 'text-tag-series',
  m: 'text-tag-meta',
  p: 'text-tag-species',
  l: 'text-tag-lore'
}
const CATEGORY_LABEL: Record<TagCategory, string> = {
  g: '일반',
  a: '작가',
  c: '캐릭터',
  s: '작품',
  m: '메타',
  p: '종',
  l: '설정'
}

let releaseTimer: ReturnType<typeof setTimeout> | undefined

interface Token {
  start: number
  query: string
  artistOnly: boolean
}

/** 커서 바로 앞의, 지금 입력 중인 태그 한 개 */
export function currentToken(text: string, caret: number): Token | null {
  const before = text.slice(0, caret)
  // 조각 <...> 안이나 주석 줄에서는 자동완성하지 않는다
  if (before.lastIndexOf('<') > before.lastIndexOf('>')) return null
  const lineStart = before.lastIndexOf('\n') + 1
  if (before.slice(lineStart).trimStart().startsWith('#')) return null
  let start = lineStart
  for (const sep of [',', '|', '{', '}', '[', ']']) start = Math.max(start, before.lastIndexOf(sep) + 1)
  const weight = before.lastIndexOf('::')
  if (weight >= 0) start = Math.max(start, weight + 2)
  const raw = before.slice(start)
  const trimmed = raw.trimStart()
  start += raw.length - trimmed.length
  const artist = /^artist:\s*/i.exec(trimmed)
  return artist
    ? { start, query: trimmed.slice(artist[0].length), artistOnly: true }
    : { start, query: trimmed, artistOnly: false }
}

/** 키보드 바로 위에 뜨는 자동완성 줄 (정확도 순, 가로 스크롤) */
function SuggestionBar(props: {
  hits: TagHit[]
  source: TagSourceSetting
  onPick: (hit: TagHit) => void
  onCycleSource: () => void
  onDismiss: () => void
}): ReactNode {
  // 누를 때 textarea의 포커스(키보드)를 잃지 않게 한다
  const keepFocus = (e: React.SyntheticEvent): void => e.preventDefault()
  // 줄이 떠 있는 동안 화면을 그 높이만큼 줄여, 아래쪽 버튼(저장·생성)이 가려지지 않게 한다
  useEffect(() => {
    clearTimeout(releaseTimer)
    document.body.classList.add('suggesting')
    return () => {
      // 바로 되돌리면 버튼을 누르는 도중(포커스가 빠지는 순간) 화면이 밀려 탭이 빗나간다.
      // 탭이 끝날 만큼 기다렸다가 되돌린다.
      releaseTimer = setTimeout(() => document.body.classList.remove('suggesting'), 400)
    }
  }, [])
  return createPortal(
    <div
      role="listbox"
      aria-label="태그 자동완성"
      className="fixed inset-x-0 bottom-0 z-[60] flex h-12 items-center border-t border-line bg-raised"
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
    >
      <button
        type="button"
        title="자동완성 출처 바꾸기"
        onClick={props.onCycleSource}
        className="h-full w-16 shrink-0 border-r border-line text-xs text-accent"
      >
        {SOURCE_LABEL[props.source]}
      </button>
      <div className="scroll-thin flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-2">
        {props.hits.map((hit) => (
          <button
            key={hit.tag}
            type="button"
            role="option"
            aria-selected={false}
            title={CATEGORY_LABEL[hit.category]}
            onClick={() => props.onPick(hit)}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-field px-3 text-[13px]"
          >
            <span className={cx('font-mono', CATEGORY_CLASS[hit.category])}>{hit.tag}</span>
            {hit.keyword && <span className="text-xs text-dim">{hit.keyword}</span>}
            {(['danbooru', 'e621'] as const).map(
              (s) =>
                hit.counts[s] !== undefined && (
                  <span key={s} className="font-mono text-[10px] text-dim">
                    {s === 'danbooru' ? 'D' : 'E'}
                    {formatCount(hit.counts[s])}
                  </span>
                )
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="자동완성 닫기"
        onClick={props.onDismiss}
        className="flex h-full w-11 shrink-0 items-center justify-center border-l border-line text-dim"
      >
        <X size={18} />
      </button>
    </div>,
    document.body
  )
}

/**
 * 프롬프트 입력란: 가중치·조각·주석을 배경색으로 표시하고(뒤에 깔린 복제 레이어),
 * 입력 중인 태그를 단부루/e621에서 자동완성한다.
 */
export function PromptEditor(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  label: string
}): ReactNode {
  const area = useRef<HTMLTextAreaElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | null>(null)
  /** 마지막 커서 위치 — 붙여넣기 버튼은 포커스가 없어도 여기에 넣는다 (없으면 맨 끝) */
  const lastCaret = useRef<number | null>(null)
  /** 비우기 직전 내용 — 값이 그대로 비어 있는 동안 되돌릴 수 있다 */
  const [cleared, setCleared] = useState<string | null>(null)
  const [pasteError, setPasteError] = useState(false)
  const source = useSettings((s) => s.tagSource)
  const [focused, setFocused] = useState(false)
  const [token, setToken] = useState<Token | null>(null)
  const [hits, setHits] = useState<TagHit[] | null>(null)

  const ranges = useMemo(() => highlightRanges(props.value), [props.value])

  const syncToken = (): void => {
    const el = area.current
    if (el) lastCaret.current = el.selectionEnd
    if (!el || el.selectionStart !== el.selectionEnd) return setToken(null)
    setToken(currentToken(el.value, el.selectionStart))
  }

  // 값이 바뀐 뒤 커서를 삽입 위치로
  useEffect(() => {
    if (pendingCaret.current === null || !area.current) return
    area.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
    syncToken()
  }, [props.value])

  const query = focused && source !== 'off' ? (token?.query ?? '') : ''
  const artistOnly = token?.artistOnly ?? false
  useEffect(() => {
    if (!query.trim()) return setHits(null)
    let live = true
    const t = setTimeout(() => {
      void searchTags(query, source, { artistOnly }).then((r) => live && setHits(r))
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, source, artistOnly])

  const pick = (hit: TagHit): void => {
    const el = area.current
    if (!el || !token) return
    const caret = el.selectionStart
    const text = (hit.category === 'a' ? 'artist:' : '') + hit.tag
    const rest = props.value.slice(caret)
    // 뒤에 이미 구분자나 가중치 닫기가 있으면 쉼표를 덧붙이지 않는다
    const tail = /^\s*(,|::|\}|\]|\|)/.test(rest) ? '' : ', '
    pendingCaret.current = token.start + text.length + tail.length
    props.onChange(props.value.slice(0, token.start) + text + tail + rest)
    setHits(null)
    el.focus()
  }

  const paste = async (): Promise<void> => {
    try {
      const clip = await readClipboard()
      if (!clip) return
      const at = Math.min(lastCaret.current ?? props.value.length, props.value.length)
      pendingCaret.current = at + clip.length
      lastCaret.current = at + clip.length
      props.onChange(props.value.slice(0, at) + clip + props.value.slice(at))
      setCleared(null)
      setPasteError(false)
    } catch {
      setPasteError(true)
      setTimeout(() => setPasteError(false), 2500)
    }
  }
  const clear = (): void => {
    setCleared(props.value)
    lastCaret.current = 0
    props.onChange('')
  }
  const tool = 'flex h-8 items-center gap-1 rounded-md px-2 text-xs text-dim active:bg-raised disabled:opacity-40'

  const text = 'p-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words'
  return (
    <div className="relative rounded-lg border border-line bg-field focus-within:border-accent">
      <div className="relative">
      <div
        ref={backdrop}
        aria-hidden="true"
        className={cx('pointer-events-none absolute inset-0 overflow-hidden text-transparent', text)}
      >
        {ranges.map((r) => (
          <span
            key={r.start}
            className={r.kind ? 'rounded-[3px]' : undefined}
            style={
              r.kind
                ? { backgroundColor: `color-mix(in srgb, var(--mark-${r.kind}) ${Math.round(r.alpha * 100)}%, transparent)` }
                : undefined
            }
          >
            {props.value.slice(r.start, r.end)}
          </span>
        ))}
        {'\n'}
      </div>
      <textarea
        ref={area}
        aria-label={props.label}
        value={props.value}
        rows={props.rows ?? 3}
        placeholder={props.placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        onChange={(e) => {
          setCleared(null)
          props.onChange(e.target.value)
          setToken(currentToken(e.target.value, e.target.selectionStart))
        }}
        onSelect={syncToken}
        onFocus={() => {
          setFocused(true)
          syncToken()
        }}
        onBlur={() => setFocused(false)}
        onScroll={(e) => {
          if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop
        }}
        className={cx(
          'no-scrollbar relative block w-full resize-y bg-transparent text-fg outline-none placeholder:text-dim/60',
          text
        )}
      />
      </div>
      <div className="relative flex items-center justify-end gap-0.5 border-t border-line/60 px-1">
        {pasteError && <span className="mr-auto pl-1.5 text-xs text-danger">클립보드를 읽지 못했습니다</span>}
        <button type="button" className={tool} aria-label={`${props.label} 붙여넣기`} onClick={() => void paste()}>
          <ClipboardPaste size={14} />
          붙여넣기
        </button>
        {cleared !== null && props.value === '' ? (
          <button
            type="button"
            className={tool}
            aria-label={`${props.label} 비우기 되돌리기`}
            onClick={() => {
              props.onChange(cleared)
              setCleared(null)
            }}
          >
            <Undo2 size={14} />
            되돌리기
          </button>
        ) : (
          <button
            type="button"
            className={tool}
            aria-label={`${props.label} 비우기`}
            disabled={props.value === ''}
            onClick={clear}
          >
            <Eraser size={14} />
            비우기
          </button>
        )}
      </div>
      {focused && hits && hits.length > 0 && (
        <SuggestionBar
          onDismiss={() => setHits(null)}
          hits={hits}
          source={source}
          onPick={pick}
          onCycleSource={() => {
            const next = SOURCE_CYCLE[(SOURCE_CYCLE.indexOf(source) + 1) % SOURCE_CYCLE.length]
            useSettings.getState().patch({ tagSource: next })
          }}
        />
      )}
    </div>
  )
}
