import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ImageUp,
  ScanFace,
  Info,
  Pin,
  RefreshCw,
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
import { fileNameFor } from '../lib/native'
import { copyImage, copyTextWithToast, describeImage, shareHistoryImages } from '../lib/share'
import { cx } from '../lib/util'
import { imageUrl, useHistory } from '../stores/history'
import { useDirector } from '../stores/director'
import { useGeneration } from '../stores/generation'
import { useImporter } from '../stores/importer'
import { useRefs, type RefType } from '../stores/refs'
import { Sheet } from './ui'
import { ZoomImage } from './ZoomImage'
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

function CopyChip(props: { onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex h-8 items-center gap-1 rounded-full border border-line px-3 text-xs text-fg active:bg-raised"
    >
      <Copy size={13} />
      {props.children}
    </button>
  )
}

/** 정보 칸 한 덩어리 — 제목 옆의 복사 단추로 글만 복사한다 */
function InfoBlock(props: { label: string; text: string; what: string; copyText?: string }): ReactNode {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <span className="text-dim">{props.label}</span>
        <button
          type="button"
          aria-label={`${props.label} 복사`}
          onClick={() => void copyTextWithToast(props.copyText ?? props.text, props.what)}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-accent active:bg-raised"
        >
          <Copy size={12} />
          복사
        </button>
      </div>
      <p className="whitespace-pre-wrap break-words font-mono">{props.text}</p>
    </div>
  )
}

export function ImageViewer(props: { onUseSource: () => void }): ReactNode {
  const { items, viewing, view, remove, toggleFav } = useHistory()
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
        <button
          type="button"
          title="시드 복사"
          onClick={() => void copyTextWithToast(String(meta.seed), '시드를')}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs text-dim active:text-fg"
        >
          {meta.width}×{meta.height} · seed {meta.seed}
        </button>
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

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {url ? (
          // key로 이미지가 바뀔 때마다 확대 상태를 처음으로 되돌린다
          <ZoomImage
            key={meta.id}
            src={url}
            alt={`생성 이미지 seed ${meta.seed}`}
            onSwipe={go}
            onZoomChange={setZoomed}
            onLongPress={() => void copyImage(meta, { haptic: true })}
          />
        ) : (
          <img src={meta.thumb} alt="" className="h-full w-full object-contain opacity-60 blur-sm" />
        )}
        {!zoomed && index > 0 && (
          <button
            type="button"
            aria-label="더 최근 이미지"
            className="absolute left-0 top-1/2 flex h-16 w-11 -translate-y-1/2 items-center justify-center rounded-r-lg bg-black/40"
            onClick={() => go(-1)}
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {!zoomed && index < items.length - 1 && (
          <button
            type="button"
            aria-label="이전 이미지"
            className="absolute right-0 top-1/2 flex h-16 w-11 -translate-y-1/2 items-center justify-center rounded-l-lg bg-black/40"
            onClick={() => go(1)}
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
          {meta.parentId !== undefined && (
            <p className="mt-1 text-dim">
              {meta.kind === 'inpaint' ? '인페인트' : 'i2i'} 원본:{' '}
              {items.some((m) => m.id === meta.parentId) ? (
                <button type="button" className="text-accent underline" onClick={() => view(meta.parentId!)}>
                  원본 그림 보기
                </button>
              ) : (
                <span>히스토리에서 지워졌거나 목록 밖에 있습니다</span>
              )}
            </p>
          )}
          <InfoBlock label="프롬프트" text={meta.prompt} what="프롬프트를" />
          {meta.negative && <InfoBlock label="네거티브" text={meta.negative} what="네거티브를" />}
          {(meta.sent?.chars ?? []).map((c, i) => (
            <InfoBlock
              key={i}
              label={`캐릭터 ${i + 1}${c.name ? ` · ${c.name}` : ''}`}
              text={c.prompt + (c.negative ? `\n(네거티브) ${c.negative}` : '')}
              copyText={c.prompt}
              what="캐릭터 프롬프트를"
            />
          ))}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <CopyChip onClick={() => void copyTextWithToast(String(meta.seed), '시드를')}>시드 복사</CopyChip>
            <CopyChip onClick={() => void copyTextWithToast(describeImage(meta), '생성 정보를')}>
              생성 정보 전부 복사
            </CopyChip>
          </div>
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
          <Action label="복사" onClick={() => void copyImage(meta)}>
            <Copy size={19} />
          </Action>
          <Action label="공유" onClick={() => void shareHistoryImages([meta])}>
            <Share2 size={19} />
          </Action>
          <Action
            label="i2i·인페인트"
            onClick={() =>
              void withBlob(async (blob) => {
                // 인페인트 결과를 다시 고칠 때는 같은 크기면 쓰던 마스크를 그대로 둔다
                await useSource.getState().setImage(blob, { originId: meta.id, keepMask: true })
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
          {meta.kind === 't2i' && meta.snap && (
            <Action
              label="다시 생성"
              onClick={() => {
                if (useGeneration.getState().running) return setNote('생성이 끝난 뒤에 다시 눌러 주세요')
                void useGeneration.getState().start({ regenerate: meta })
                setNote('같은 설정, 새 시드로 한 장 더 생성합니다')
              }}
            >
              <RefreshCw size={19} />
            </Action>
          )}
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
