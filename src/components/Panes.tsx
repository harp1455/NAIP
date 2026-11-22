import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CheckSquare, Download, Star, Trash2, X } from 'lucide-react'
import { cx } from '../lib/util'
import { useGeneration } from '../stores/generation'
import { useScenes } from '../stores/scenes'
import { useSaver } from '../stores/saver'
import { imageUrl, useHistory } from '../stores/history'
import { Button, Empty, IconButton } from './ui'

/** 결과 탭: 가장 최근 결과를 크게 + 최근 결과 스트립 */
export function PreviewPane(): ReactNode {
  const { items, view } = useHistory()
  const { latestId, setLatest, running, phase } = useGeneration()
  const meta = items.find((m) => m.id === latestId) ?? items[0]
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!meta) return setUrl(null)
    let live = true
    void imageUrl(meta.id, meta.mime).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [meta?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!meta) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-lg font-semibold">{running ? '생성하고 있어요' : '아직 결과가 없어요'}</p>
        <p className="text-sm text-dim">생성된 이미지가 여기에 표시됩니다</p>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        aria-label="이미지 크게 보기"
        className="relative min-h-0 flex-1 bg-black/40"
        onClick={() => view(meta.id)}
      >
        <img
          src={url ?? meta.thumb}
          alt={`생성 이미지 seed ${meta.seed}`}
          className={cx('absolute inset-0 h-full w-full object-contain', !url && 'blur-sm')}
        />
        {running && phase === 'generating' && (
          <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-accent">
            다음 장 생성 중…
          </span>
        )}
      </button>
      <ul className="scroll-thin flex shrink-0 gap-1.5 overflow-x-auto border-t border-line p-2">
        {items.slice(0, 30).map((m) => (
          <li key={m.id} className="shrink-0">
            <button
              type="button"
              aria-label={`seed ${m.seed} 미리보기`}
              onClick={() => setLatest(m.id)}
              className={cx(
                'block h-16 w-16 overflow-hidden rounded-md border-2',
                m.id === meta.id ? 'border-accent' : 'border-transparent'
              )}
            >
              <img src={m.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function HistoryPane(): ReactNode {
  const { items, total, hasMore, loadMore, view, remove, filter, setFilter } = useHistory()
  const scenes = useScenes((x) => x.scenes)
  const sceneName =
    filter && 'sceneId' in filter
      ? (scenes.find((x) => x.id === filter.sceneId)?.name ?? items[0]?.sceneName ?? '삭제된 씬')
      : null
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadMore, items.length])

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
                {filter ? `${items.length}/${total}` : total}
              </span>
            </span>
            <div className="scroll-thin flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-2">
              <button
                type="button"
                aria-pressed={!!filter && 'fav' in filter}
                onClick={() => void setFilter(filter && 'fav' in filter ? null : { fav: true })}
                className={cx(
                  'flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs',
                  filter && 'fav' in filter ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
                )}
              >
                <Star size={13} />
                즐겨찾기
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
            <Button variant="ghost" disabled={!items.length} onClick={() => setSelected(new Set())}>
              선택
            </Button>
          </>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
        {items.length === 0 ? (
          <Empty>{filter ? '조건에 맞는 이미지가 없습니다' : '생성한 이미지가 여기에 쌓입니다'}</Empty>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5">
            {items.map((m) => {
              const on = selected?.has(m.id) ?? false
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-label={`seed ${m.seed}${m.saved ? ' 저장됨' : ''}`}
                    aria-pressed={selected ? on : undefined}
                    onClick={() => (selected ? toggle(m.id) : view(m.id))}
                    className={cx(
                      'relative block aspect-square w-full overflow-hidden rounded-md border-2',
                      on ? 'border-accent' : 'border-transparent'
                    )}
                  >
                    <img src={m.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
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
                    {m.fav && !on && (
                      <Star size={14} className="absolute right-1 top-1 fill-accent text-accent drop-shadow" />
                    )}
                    {on && (
                      <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-fg">
                        <Check size={13} strokeWidth={3} />
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <div ref={sentinel} className="h-4" />
      </div>
    </div>
  )
}
