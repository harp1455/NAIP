import { useEffect, useState, type ReactNode } from 'react'
import { Check, CheckSquare, Copy, Download, Search, Share2, Star, Trash2, X } from 'lucide-react'
import type { HistoryMeta } from '../lib/db'
import { useLongPress } from '../lib/longpress'
import { copyImage, shareHistoryImages } from '../lib/share'
import { cx } from '../lib/util'
import { useScrollReset, useVirtualGrid } from '../lib/virtual'
import { useGeneration } from '../stores/generation'
import { useScenes } from '../stores/scenes'
import { useSaver } from '../stores/saver'
import { imageUrl, useHistory } from '../stores/history'
import { Button, Empty, IconButton } from './ui'

/** 결과 탭: 가장 최근 결과를 크게 + 최근 결과 스트립 */
export function PreviewPane(): ReactNode {
  const { items, view } = useHistory()
  const { latestId, setLatest, running, phase, preview } = useGeneration()
  const meta = items.find((m) => m.id === latestId) ?? items[0]
  const [url, setUrl] = useState<string | null>(null)
  const index = meta ? items.findIndex((m) => m.id === meta.id) : -1
  // 좌우로 밀어 이전·다음 결과 (왼쪽으로 밀면 더 이전에 만든 그림)
  const press = useLongPress(
    () => meta && void copyImage(meta, { haptic: true }),
    (dir) => {
      const next = items[index + dir]
      if (next) setLatest(next.id)
    }
  )

  useEffect(() => {
    if (!meta) return setUrl(null)
    let live = true
    void imageUrl(meta.id, meta.mime).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [meta?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 생성 중 스트리밍 미리보기가 있으면 그것을 크게 보여 준다 (완성되면 결과로 바뀐다)
  const streamFrame = running && preview ? preview : null

  if (!meta && !streamFrame) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-lg font-semibold">{running ? '생성하고 있어요' : '아직 결과가 없어요'}</p>
        <p className="text-sm text-dim">생성된 이미지가 여기에 표시됩니다</p>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 bg-black/40">
        {streamFrame && (
          <div className="absolute inset-0 z-10 bg-black/60" aria-live="polite">
            {streamFrame.url ? (
              <img
                src={streamFrame.url}
                alt="생성 중 미리보기"
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-dim">그리는 중…</div>
            )}
            <div className="absolute inset-x-3 bottom-3 rounded-full bg-black/60 p-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.round((streamFrame.step / Math.max(1, streamFrame.total)) * 100)}%` }}
                />
              </div>
            </div>
            <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-accent">
              미리보기 · {streamFrame.step}/{streamFrame.total}단계
            </span>
          </div>
        )}
        {meta && (
        <button
          type="button"
          aria-label="이미지 크게 보기 (꾹 누르면 복사)"
          className="no-callout absolute inset-0 touch-pan-y"
          onClick={() => view(meta.id)}
          {...press}
        >
          <img
            src={url ?? meta.thumb}
            alt={`생성 이미지 seed ${meta.seed}`}
            draggable={false}
            className={cx('absolute inset-0 h-full w-full object-contain', !url && 'blur-sm')}
          />
        </button>
        )}
        {meta && items.length > 1 && !streamFrame && (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white">
            {index + 1}/{items.length}
          </span>
        )}
        {running && phase === 'generating' && !streamFrame && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-accent">
            다음 장 생성 중…
          </span>
        )}
        {meta && !streamFrame && (
        <div className="absolute right-2 top-2 flex gap-1.5">
          <button
            type="button"
            aria-label="클립보드에 복사"
            title="클립보드에 복사"
            onClick={() => void copyImage(meta)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white active:bg-black/80"
          >
            <Copy size={18} />
          </button>
          <button
            type="button"
            aria-label="공유"
            title="공유"
            onClick={() => void shareHistoryImages([meta])}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white active:bg-black/80"
          >
            <Share2 size={18} />
          </button>
        </div>
        )}
      </div>
      <ul className="scroll-thin flex shrink-0 gap-1.5 overflow-x-auto border-t border-line p-2">
        {items.slice(0, 30).map((m) => (
          <li key={m.id} className="shrink-0">
            <StripThumb meta={m} active={m.id === meta?.id} onPick={() => setLatest(m.id)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function StripThumb(props: { meta: HistoryMeta; active: boolean; onPick: () => void }): ReactNode {
  const press = useLongPress(() => void copyImage(props.meta, { haptic: true }))
  return (
    <button
      type="button"
      aria-label={`seed ${props.meta.seed} 미리보기 (꾹 누르면 복사)`}
      onClick={props.onPick}
      {...press}
      className={cx(
        'no-callout block h-16 w-16 overflow-hidden rounded-md border-2',
        props.active ? 'border-accent' : 'border-transparent'
      )}
    >
      {props.meta.thumb ? (
        <img src={props.meta.thumb} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
      ) : (
        <span className="block h-full w-full bg-raised" />
      )}
    </button>
  )
}

/** 히스토리 칸 하나 — 누르면 크게 보기(선택 중이면 선택), 꾹 누르면 클립보드에 복사 */
function HistoryThumb(props: {
  meta: HistoryMeta
  selecting: boolean
  selected: boolean
  onPress: () => void
}): ReactNode {
  const m = props.meta
  const on = props.selected
  const press = useLongPress(() => void copyImage(m, { haptic: true }))
  // 썸네일 파일이 없으면 원본으로 다시 만든다 (한 장에 한 번)
  useEffect(() => {
    if (!m.thumb) void useHistory.getState().repairThumb(m.id)
  }, [m.id, m.thumb])
  return (
    <button
      type="button"
      aria-label={`seed ${m.seed}${m.saved ? ' 저장됨' : ''}`}
      aria-pressed={props.selecting ? on : undefined}
      onClick={props.onPress}
      {...press}
      className={cx(
        'no-callout relative block aspect-square w-full overflow-hidden rounded-md border-2',
        on ? 'border-accent' : 'border-transparent'
      )}
    >
      {m.thumb ? (
        <img
          src={m.thumb}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => void useHistory.getState().repairThumb(m.id)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="block h-full w-full bg-raised" />
      )}
      {m.kind !== 't2i' && (
        <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px]">
          {{ i2i: 'i2i', inpaint: '인페', director: '도구', upscale: '2x', t2i: '' }[m.kind]}
        </span>
      )}
      {m.saved && (
        <span
          title={`저장됨: ${m.saved}`}
          className="absolute bottom-1 right-1 flex h-5 items-center gap-0.5 rounded-full bg-ok px-1.5 text-[10px] font-semibold text-black"
        >
          <Download size={11} strokeWidth={3} />
          저장됨
        </span>
      )}
      {m.fav && !on && <Star size={14} className="absolute right-1 top-1 fill-accent text-accent drop-shadow" />}
      {on && (
        <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-fg">
          <Check size={13} strokeWidth={3} />
        </span>
      )}
    </button>
  )
}

export function HistoryPane(): ReactNode {
  const { items, total, hasMore, loadMore, view, remove, filter, setFilter, matchCount } = useHistory()
  const searching = !!filter && 'search' in filter
  const [query, setQuery] = useState(searching ? (filter as { search: string }).search : '')
  const [searchOpen, setSearchOpen] = useState(searching)
  // 입력을 잠깐 멈추면 검색한다
  useEffect(() => {
    if (!searchOpen) return
    const t = setTimeout(() => {
      const q = query.trim()
      const current = useHistory.getState().filter
      if (!q) {
        if (current && 'search' in current) void setFilter(null)
      } else if (!(current && 'search' in current && current.search === q)) void setFilter({ search: q })
    }, 300)
    return () => clearTimeout(t)
  }, [query, searchOpen, setFilter])
  const scenes = useScenes((x) => x.scenes)
  const sceneName =
    filter && 'sceneId' in filter
      ? (scenes.find((x) => x.id === filter.sceneId)?.name ?? items[0]?.sceneName ?? '삭제된 씬')
      : null
  const [selected, setSelected] = useState<Set<number> | null>(null)
  // 보이는 줄만 그린다 (수만 장이어도 칸 수십 개). 끝 근처까지 내려오면 다음 페이지를 읽는다
  const grid = useVirtualGrid(items.length, { min: 104, gap: 6 })
  useScrollReset(grid.ref, filter)
  useEffect(() => {
    if (grid.nearEnd && hasMore) void loadMore()
  }, [grid.nearEnd, hasMore, loadMore, items.length])

  const toggle = (id: number): void => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const saveSelected = (): void => {
    if (!selected) return
    // 오래된 것부터 — 일괄 이름의 번호가 만든 순서를 따르게
    const picked = items.filter((x) => selected.has(x.id)).reverse()
    useSaver.getState().open(picked, () => setSelected(null))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-3 pr-1">
        {selected ? (
          <>
            <span className="flex-1 text-sm">{selected.size}장 선택</span>
            <IconButton
              label="모두 선택"
              onClick={() => setSelected(new Set(items.map((m) => m.id)))}
            >
              <CheckSquare size={18} />
            </IconButton>
            <IconButton
              label="선택한 이미지 공유"
              disabled={!selected.size}
              onClick={() => void shareHistoryImages(items.filter((x) => selected.has(x.id)).reverse())}
            >
              <Share2 size={18} />
            </IconButton>
            <IconButton label="선택한 이미지 저장" disabled={!selected.size} onClick={saveSelected}>
              <Download size={18} />
            </IconButton>
            <IconButton
              label="선택한 이미지 삭제"
              disabled={!selected.size}
              onClick={() => {
                if (!window.confirm(`선택한 ${selected.size}장을 히스토리에서 삭제할까요?`)) return
                void remove([...selected]).then(() => setSelected(null))
              }}
            >
              <Trash2 size={18} className="text-danger" />
            </IconButton>
            <IconButton label="선택 취소" onClick={() => setSelected(null)}>
              <X size={18} />
            </IconButton>
          </>
        ) : (
          <>
            <span className="shrink-0 text-sm font-semibold">
              히스토리{' '}
              <span className="ml-1 font-mono text-xs font-normal text-dim">
                {matchCount !== null ? `${matchCount}/${total}` : total}
              </span>
            </span>
            <div className="scroll-thin flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-2">
              <button
                type="button"
                aria-pressed={!!filter && 'fav' in filter}
                onClick={() => {
                  setQuery('')
                  void setFilter(filter && 'fav' in filter ? null : { fav: true })
                }}
                className={cx(
                  'flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs',
                  filter && 'fav' in filter ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
                )}
              >
                <Star size={13} />
                즐겨찾기
              </button>
              <button
                type="button"
                aria-pressed={!!filter && 'unsaved' in filter}
                onClick={() => {
                  setQuery('')
                  void setFilter(filter && 'unsaved' in filter ? null : { unsaved: true })
                }}
                className={cx(
                  'flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs',
                  filter && 'unsaved' in filter ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
                )}
              >
                <Download size={13} />
                미저장
              </button>
              {sceneName !== null && (
                <button
                  type="button"
                  onClick={() => void setFilter(null)}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-accent bg-accent/15 px-2.5 text-xs text-accent"
                >
                  <span className="max-w-32 truncate">씬: {sceneName}</span>
                  <X size={13} />
                </button>
              )}
            </div>
            <IconButton
              label="히스토리 검색"
              active={searchOpen}
              onClick={() => {
                if (searchOpen) {
                  setSearchOpen(false)
                  setQuery('')
                  if (searching) void setFilter(null)
                } else setSearchOpen(true)
              }}
            >
              <Search size={18} />
            </IconButton>
            <Button variant="ghost" disabled={!items.length} onClick={() => setSelected(new Set())}>
              선택
            </Button>
          </>
        )}
      </div>
      {searchOpen && !selected && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
          <input
            type="search"
            aria-label="히스토리 검색어"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="프롬프트·캐릭터·씬·시드 (쉼표로 여러 개)"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-field px-3 text-sm text-fg placeholder:text-dim/60"
          />
          {query && (
            <IconButton label="검색어 지우기" onClick={() => setQuery('')}>
              <X size={17} />
            </IconButton>
          )}
        </div>
      )}
      <div ref={grid.ref} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="history-scroll">
        {items.length === 0 ? (
          <Empty>{searching ? '검색어와 맞는 이미지가 없습니다' : filter ? '조건에 맞는 이미지가 없습니다' : '생성한 이미지가 여기에 쌓입니다'}</Empty>
        ) : (
          <ul className="relative" style={{ height: grid.height }}>
            {items.slice(grid.start, grid.end).map((m, k) => {
              const at = grid.pos(grid.start + k)
              return (
                <li
                  key={m.id}
                  className="absolute"
                  style={{ top: at.top, left: at.left, width: grid.size, height: grid.size }}
                >
                  <HistoryThumb
                    meta={m}
                    selecting={!!selected}
                    selected={selected?.has(m.id) ?? false}
                    onPress={() => (selected ? toggle(m.id) : view(m.id))}
                  />
                </li>
              )
            })}
          </ul>
        )}
        {hasMore && <div className="h-4" />}
      </div>
    </div>
  )
}
