import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageUp,
  ScanFace,
  Info,
  Pin,
  Share2,
  SlidersHorizontal,
  Star,
  Wand2,
  Trash2,
  X
} from 'lucide-react'
import * as db from '../lib/db'
import { fromMetadata, fromSnapshot } from '../lib/apply'
import { useBackClose } from '../lib/back'
import { readImageSettings } from '../lib/metadata'
import { fileNameFor, shareImage } from '../lib/native'
import { cx } from '../lib/util'
import { imageUrl, useHistory } from '../stores/history'
import { useDirector } from '../stores/director'
import { useImporter } from '../stores/importer'
import { useRefs, type RefType } from '../stores/refs'
import { Sheet } from './ui'
import { usePrompt } from '../stores/prompt'
import { useSaver } from '../stores/saver'
import { useSource } from '../stores/source'

function Action(props: {
  label: string
  onClick: () => void
  children: ReactNode
  danger?: boolean
  pressed?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={cx(
        'flex h-14 min-w-[68px] shrink-0 grow flex-col items-center justify-center gap-1 whitespace-nowrap px-2 text-[11px] active:bg-white/10',
        props.danger ? 'text-danger' : 'text-fg'
      )}
    >
      {props.children}
      <span>{props.label}</span>
    </button>
  )
}

export function ImageViewer(props: { onUseSource: () => void }): ReactNode {
  const { items, viewing, view, remove, toggleFav } = useHistory()
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const index = items.findIndex((m) => m.id === viewing)
  const meta = items[index]
  const [url, setUrl] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const [info, setInfo] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [refPicker, setRefPicker] = useState(false)
  useBackClose(() => view(null))

  useEffect(() => {
    setUrl(null)
    setZoomed(false)
    if (!meta) return
    let live = true
    void imageUrl(meta.id, meta.mime).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [meta?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 2200)
    return () => clearTimeout(t)
  }, [note])

  if (!meta) return null
  const withBlob = async (fn: (blob: Blob, name: string) => Promise<void>, ok?: string): Promise<void> => {
    try {
      const blob = await db.getBlob(meta.id, meta.mime)
      if (!blob) throw new Error('원본을 찾을 수 없습니다')
      await fn(blob, fileNameFor(meta.id, meta.seed, meta.mime))
      if (ok) setNote(ok)
    } catch (e) {
      setNote((e as Error).message)
    }
  }
  const go = (d: number): void => {
    const next = items[index + d]
    if (next) view(next.id)
  }

  return (
    <div className="safe-top fixed inset-0 z-50 flex flex-col bg-black">
      <header className="flex h-12 shrink-0 items-center gap-1 px-1 text-sm">
        <button type="button" aria-label="닫기" className="flex h-10 w-10 items-center justify-center" onClick={() => view(null)}>
          <X size={22} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-dim">
          {meta.width}×{meta.height} · seed {meta.seed}
        </span>
        {meta.saved && (
          <span className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-ok px-2 text-[11px] font-semibold text-black">
            <Download size={12} strokeWidth={3} />
            저장됨
          </span>
        )}
        <button
          type="button"
          aria-label="생성 정보"
          aria-pressed={info}
          className={cx('flex h-10 w-10 items-center justify-center', info && 'text-accent')}
          onClick={() => setInfo(!info)}
        >
          <Info size={20} />
        </button>
      </header>

      <div
        className={cx('relative min-h-0 flex-1', zoomed ? 'overflow-auto' : 'overflow-hidden')}
        onClick={() => setZoomed(!zoomed)}
        onTouchStart={(e) => {
          const t = e.touches[0]
          swipe.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null
        }}
        onTouchEnd={(e) => {
          const from = swipe.current
          swipe.current = null
          if (!from || zoomed) return
          const t = e.changedTouches[0]
          const dx = t.clientX - from.x
          // 가로로 충분히 밀었을 때만 넘긴다 (세로 스크롤·탭과 구분)
          if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(t.clientY - from.y) * 1.5) {
            e.preventDefault()
            go(dx < 0 ? 1 : -1)
          }
        }}
      >
        {url ? (
          <img
            src={url}
            alt={`생성 이미지 seed ${meta.seed}`}
            draggable={false}
            className={zoomed ? 'block w-[250%] max-w-none' : 'h-full w-full object-contain'}
          />
        ) : (
          <img src={meta.thumb} alt="" className="h-full w-full object-contain opacity-60 blur-sm" />
        )}
        {!zoomed && index > 0 && (
          <button
            type="button"
            aria-label="더 최근 이미지"
            className="absolute left-0 top-1/2 flex h-16 w-11 -translate-y-1/2 items-center justify-center rounded-r-lg bg-black/40"
            onClick={(e) => {
              e.stopPropagation()
              go(-1)
            }}
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {!zoomed && index < items.length - 1 && (
          <button
            type="button"
            aria-label="이전 이미지"
            className="absolute right-0 top-1/2 flex h-16 w-11 -translate-y-1/2 items-center justify-center rounded-l-lg bg-black/40"
            onClick={(e) => {
              e.stopPropagation()
              go(1)
            }}
          >
            <ChevronRight size={24} />
          </button>
        )}
        {note && (
          <div role="status" className="absolute inset-x-0 bottom-3 mx-auto w-fit max-w-[90%] rounded-full bg-raised px-4 py-2 text-xs">
            {note}
          </div>
        )}
      </div>

      {info && (
        <div className="scroll-thin max-h-[32vh] shrink-0 select-text overflow-y-auto border-t border-line bg-panel p-3 text-xs">
          <p className="text-dim">
            {meta.model} · {meta.kind}
            {meta.sceneName ? ` · 씬 ${meta.sceneName}` : ''} · {new Date(meta.ts).toLocaleString('ko-KR')}
          </p>
          {meta.saved && <p className="mt-1 text-ok">저장 위치: Pictures/NAIP/{meta.saved}</p>}
          <p className="mt-2 text-dim">프롬프트</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words font-mono">{meta.prompt}</p>
          <p className="mt-2 text-dim">네거티브</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words font-mono">{meta.negative}</p>
        </div>
      )}

      <footer className="safe-bottom shrink-0 border-t border-line bg-panel">
        <div className="scroll-thin flex overflow-x-auto">
          <Action label="즐겨찾기" pressed={!!meta.fav} onClick={() => void toggleFav(meta.id)}>
            <Star size={19} className={meta.fav ? 'fill-accent text-accent' : ''} />
          </Action>
          <Action label={meta.saved ? '다시 저장' : '저장'} onClick={() => useSaver.getState().open([meta])}>
            <Download size={19} className={meta.saved ? 'text-ok' : ''} />
          </Action>
          <Action label="공유" onClick={() => void withBlob(shareImage)}>
            <Share2 size={19} />
          </Action>
          <Action
            label="i2i·인페인트"
            onClick={() =>
              void withBlob(async (blob) => {
                await useSource.getState().setImage(blob)
                view(null)
                props.onUseSource()
              })
            }
          >
            <ImageUp size={19} />
          </Action>
          <Action label="레퍼런스로" onClick={() => setRefPicker(true)}>
            <ScanFace size={19} />
          </Action>
          <Action
            label="도구"
            onClick={() =>
              void withBlob(async (blob) => {
                view(null)
                useDirector.getState().show(blob)
              })
            }
          >
            <Wand2 size={19} />
          </Action>
          <Action
            label="설정 적용"
            onClick={() => {
              const origin = meta.sceneName ?? `seed ${meta.seed}`
              if (meta.snap) {
                view(null)
                return useImporter.getState().open(fromSnapshot(meta.snap, meta.seed), origin)
              }
              void withBlob(async (blob) => {
                const m = await readImageSettings(blob)
                if (!m) throw new Error('이 이미지에는 생성 정보가 없습니다')
                view(null)
                useImporter.getState().open(fromMetadata(m), origin)
              })
            }}
          >
            <SlidersHorizontal size={19} />
          </Action>
          <Action
            label="시드 고정"
            onClick={() => {
              usePrompt.getState().set({ seed: String(meta.seed) })
              setNote(`시드 ${meta.seed} 고정`)
            }}
          >
            <Pin size={19} />
          </Action>
          <Action
            label="삭제"
            danger
            onClick={() => {
              if (!window.confirm('이 이미지를 히스토리에서 삭제할까요?')) return
              const next = items[index + 1] ?? items[index - 1]
              void remove([meta.id]).then(() => view(next?.id ?? null))
            }}
          >
            <Trash2 size={19} />
          </Action>
        </div>
      </footer>
      {refPicker && (
        <Sheet top title="이 이미지를 레퍼런스로" onClose={() => setRefPicker(false)}>
          <p className="mb-2 text-xs text-dim">
            이 그림에서 무엇을 가져올지 고르세요. 레퍼런스 목록에 추가되고 바로 켜집니다.
          </p>
          <div className="flex flex-col gap-1.5">
            {(
              [
                ['character', '캐릭터', '생김새를 가져옵니다'],
                ['style', '스타일', '그림체를 가져옵니다'],
                ['costume', '의상', '옷차림을 가져옵니다 (V5 전용)'],
                ['character&style', '캐릭터 + 스타일', '생김새와 그림체를 함께'],
                ['vibe', '바이브 트랜스퍼', '분위기를 가져옵니다 (V4.5 전용, 인코딩 2 Anlas)']
              ] as const
            ).map(([kind, label, hint]) => (
              <button
                key={kind}
                type="button"
                className="rounded-lg border border-line bg-field px-3 py-2.5 text-left active:bg-raised"
                onClick={() => {
                  setRefPicker(false)
                  const name = meta.sceneName ?? `seed ${meta.seed}`
                  void withBlob(
                    (blob) =>
                      kind === 'vibe'
                        ? useRefs.getState().addVibeFrom(blob, name)
                        : useRefs.getState().addCharRefFrom(blob, name, kind as RefType),
                    `${label} 레퍼런스로 추가했습니다`
                  )
                }}
              >
                <span className="block text-sm">{label}</span>
                <span className="block text-xs text-dim">{hint}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  )
}
