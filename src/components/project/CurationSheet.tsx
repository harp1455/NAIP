/**
 * 선별 — 한 조합의 그림을 채택/보류/탈락/미선별로 고르고, 채택 교체(버전)·대표 그림·설명·재생성 필요·더 생성.
 * 빠른 선별은 한 장씩 크게 보며 큰 단추로 고르고 다음 장으로 넘어간다 (좌우로 밀어 이동).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, CircleDot, Layers, Pause, Plus, Replace, Star, X } from 'lucide-react'
import { useBackClose } from '../../lib/back'
import { cx } from '../../lib/util'
import {
  CURATION_LABEL,
  adoptedImages,
  curationCounts,
  expandMatrix,
  itemStatus,
  representativeOf,
  reviewState,
  useProjects,
  versionChain,
  type AssetImage,
  type AssetItem,
  type CurationMark,
  type Project
} from '../../project'
import { enqueueCombo } from '../../project/run'
import { imageUrl } from '../../stores/history'
import { checkerStyle, hasAlphaBackground } from '../../lib/alpha'
import { toast } from '../../stores/toast'
import { Button, IconButton, Row, Select, Sheet, Stepper, Toggle } from '../ui'
import { ZoomImage } from '../ZoomImage'
import { Chip, DraftInput, StatusBadge, Thumb, useMetas } from './common'
import { orphanLabel } from './MatrixView'

const MARK_STYLE: Record<CurationMark, string> = {
  unreviewed: 'bg-black/70 text-white',
  adopted: 'bg-ok text-black',
  hold: 'bg-tag-meta text-black',
  rejected: 'bg-danger text-white'
}

type MarkFilter = CurationMark | 'all'

/** 다음에 고를 조합 (선별 필요 상태, 행렬 순서로 이어서) */
export interface NextCombo {
  key: string
  label: string
  /** 남은 조합 수 (이것 포함) */
  left: number
}

export function CurationSheet(props: {
  project: Project
  itemKey: string
  /** 열자마자 한 장씩 고르기 (선별하기 · 다음 조합) — 고르기를 닫으면 이 시트도 닫는다 */
  startReview?: boolean
  next?: NextCombo
  onNext?: (key: string) => void
  onClose: () => void
}): ReactNode {
  const p = props.project
  const key = props.itemKey
  const s = useProjects.getState()
  const combo = useMemo(() => expandMatrix(p, { keys: [key] }).combos[0] ?? null, [p, key])
  const item: AssetItem = p.items[key] ?? { key, images: [], queued: 0, generating: 0, failed: 0 }
  const target = combo?.target ?? p.defaults.target
  const status = itemStatus(p.items[key], target)
  const counts = curationCounts(item)
  const [filter, setFilter] = useState<MarkFilter>('all')
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const [more, setMore] = useState(Math.max(1, p.defaults.count))
  // 최신이 앞에
  const images = useMemo(() => [...item.images].sort((a, b) => b.ts - a.ts), [item.images])
  const [review, setReview] = useState<{ index: number; quick: boolean } | null>(() =>
    props.startReview && images.length ? { index: Math.max(0, images.findIndex((i) => i.mark === 'unreviewed')), quick: true } : null
  )
  const shown = filter === 'all' ? images : images.filter((i) => i.mark === filter)
  const metas = useMetas(images.map((i) => i.id))
  const rep = representativeOf(item)
  const label = combo?.label ?? orphanLabel(p, key)

  const mark = (ids: number[], m: CurationMark): void => s.setMarks(p.id, key, ids, m)

  return (
    <Sheet
      title={label}
      onClose={props.onClose}
      actions={<StatusBadge status={status} />}
      footer={
        selected ? (
          <>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              취소
            </Button>
            {(['adopted', 'hold', 'rejected', 'unreviewed'] as const).map((m) => (
              <Button
                key={m}
                variant={m === 'adopted' ? 'primary' : m === 'rejected' ? 'danger' : 'default'}
                className="flex-1 px-1"
                disabled={!selected.size}
                onClick={() => {
                  mark([...selected], m)
                  setSelected(null)
                }}
              >
                {CURATION_LABEL[m]}
              </Button>
            ))}
          </>
        ) : (
          <>
            <Button variant="default" className="px-3" disabled={!images.length} onClick={() => setSelected(new Set())}>
              선택
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              disabled={!images.length}
              onClick={() => {
                const first = images.findIndex((i) => i.mark === 'unreviewed')
                setFilter('all')
                setReview({ index: Math.max(0, first), quick: true })
              }}
            >
              <Layers size={16} />
              빠른 선별{counts.unreviewed ? ` (${counts.unreviewed})` : ''}
            </Button>
            {props.next && props.onNext && (
              <Button variant="default" className="px-3" onClick={() => props.onNext!(props.next!.key)}>
                다음 조합
                <ChevronRight size={16} />
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs text-dim">
          채택 <b className="text-fg">{counts.adopted}</b>/{target} · 그림 {counts.total}장
          {item.queued + item.generating ? ` · 생성 대기 ${item.queued + item.generating}` : ''}
          {item.failed ? ` · 실패 ${item.failed}` : ''}
          {!combo && ' · 지금 행렬에 없는 조합'}
        </div>

        <div className="rounded-lg border border-line bg-field px-3">
          {combo && (
            <div className="flex min-h-12 items-center gap-2 py-1.5">
              <span className="flex-1 text-sm">이 조합 더 생성</span>
              <Stepper label="더 생성할 장수" value={more} min={1} max={50} onChange={setMore} />
              <Button
                variant="primary"
                className="h-11 px-3"
                onClick={() => {
                  const r = enqueueCombo(p, key, more)
                  toast(typeof r === 'string' ? r : `${r.images}장을 대기열에 넣었습니다`, typeof r === 'string')
                }}
              >
                <Plus size={16} />
                생성
              </Button>
            </div>
          )}
          <Row label="재생성 필요" hint={'다시 만들 조합으로 표시 ("실패한 것만" 계획에 들어감)'}>
            <Toggle label="재생성 필요" checked={!!item.redo} onChange={(on) => s.setRedo(p.id, key, on)} />
          </Row>
        </div>

        <div className="scroll-thin flex gap-1.5 overflow-x-auto" role="group" aria-label="표시 거르기">
          {(['all', 'unreviewed', 'adopted', 'hold', 'rejected'] as const).map((f) => (
            <Chip key={f} on={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? `전체 ${counts.total}` : `${CURATION_LABEL[f]} ${counts[f]}`}
            </Chip>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-dim">
            {images.length ? '이 표시의 그림이 없습니다' : '아직 그림이 없습니다. "이 조합 더 생성"이나 생성 계획으로 만들어 주세요'}
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4" aria-label="그림">
            {shown.map((img) => {
              const on = selected?.has(img.id) ?? false
              const code = img.slot ? item.codes?.[String(img.slot)] : undefined
              return (
                <li key={img.id}>
                  <button
                    type="button"
                    aria-label={`${CURATION_LABEL[img.mark]} 그림 seed ${img.seed ?? ''}`}
                    aria-pressed={selected ? on : undefined}
                    onClick={() => {
                      if (selected) {
                        const next = new Set(selected)
                        if (on) next.delete(img.id)
                        else next.add(img.id)
                        setSelected(next)
                      } else setReview({ index: images.indexOf(img), quick: false })
                    }}
                    className={cx('relative block aspect-[3/4] w-full overflow-hidden rounded-md border-2', on ? 'border-accent' : 'border-transparent')}
                  >
                    <Thumb meta={metas.get(img.id)} className={cx('absolute inset-0 h-full w-full', img.mark === 'rejected' && 'opacity-40')} />
                    <span className={cx('absolute left-1 top-1 rounded-full px-1.5 text-[10px] font-semibold', MARK_STYLE[img.mark])}>
                      {CURATION_LABEL[img.mark]}
                      {img.mark === 'adopted' && img.slot ? ` ${img.slot}` : ''}
                    </span>
                    {rep?.id === img.id && <Star size={14} className="absolute right-1 top-1 fill-accent text-accent drop-shadow" aria-label="대표" />}
                    {(code || (img.version ?? 1) > 1) && (
                      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
                        {code ?? ''}
                        {(img.version ?? 1) > 1 ? ` v${img.version}` : ''}
                      </span>
                    )}
                    {selected && on && (
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
      </div>
      {review &&
        createPortal(
        <ReviewView
          project={p}
          itemKey={key}
          label={label}
          images={images}
          start={review.index}
          quick={review.quick}
          target={target}
          sequential={!!props.startReview}
          next={props.next}
          onNext={props.onNext}
          onClose={() => (props.startReview ? props.onClose() : setReview(null))}
        />,
          document.body
        )}
    </Sheet>
  )
}

/** 한 장씩 크게 보며 고르기 */
function ReviewView(props: {
  project: Project
  itemKey: string
  /** 조합 이름 ("민지 · 울음") — 무엇을 고르는지 맨 위에 */
  label: string
  images: AssetImage[]
  start: number
  quick: boolean
  target: number
  /** 선별하기로 열었다 (다음 조합이 없으면 다 봤다고 알린다) */
  sequential: boolean
  next?: NextCombo
  onNext?: (key: string) => void
  onClose: () => void
}): ReactNode {
  const p = props.project
  const key = props.itemKey
  const s = useProjects.getState()
  const item = p.items[key]
  // 표시 순서는 연 순간의 것으로 고정 (고르는 사이 목록이 바뀌어도 자리가 흔들리지 않게)
  const [order] = useState(() => props.images.map((i) => i.id))
  const [index, setIndex] = useState(Math.min(props.start, Math.max(0, order.length - 1)))
  const [advance, setAdvance] = useState(props.quick)
  const [url, setUrl] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  useBackClose(props.onClose)
  const id = order[index]
  const img = item?.images.find((i) => i.id === id)
  const metas = useMetas(img ? [img.id] : [])
  const meta = img ? metas.get(img.id) : undefined

  useEffect(() => {
    setUrl(null)
    setZoomed(false)
    if (!img) return
    let live = true
    void imageUrl(img.id, img.mime ?? meta?.mime ?? 'image/png').then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [img?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!img || !item) {
    return (
      <div className="safe-top fixed inset-0 z-[55] flex flex-col items-center justify-center gap-3 bg-black text-sm text-dim">
        그림이 없습니다
        <Button onClick={props.onClose}>닫기</Button>
      </div>
    )
  }
  const adopted = adoptedImages(item).filter((a) => a.id !== img.id)
  const counts = curationCounts(item)
  // 이 조합을 다 골랐다 — 목표만큼 채택했거나 미선별 그림이 없다 (보류가 남았으면 그렇다고 알린다 — 아직 고를 조합)
  const state = reviewState(item, props.target)
  const showNext = state !== 'open' && (!!props.next || props.sequential)
  const doneText =
    state === 'filled' ? '채택 목표를 채웠습니다' : state === 'held' ? `보류 ${counts.hold}장이 남았습니다` : '이 조합의 그림을 다 봤습니다'
  const leftText = props.next
    ? `고를 조합 ${props.next.left}개 남음`
    : state === 'held'
      ? '보류를 채택·탈락으로 정하면 이 조합이 끝납니다'
      : '고를 조합을 모두 봤습니다'
  const chain = versionChain(item, img.id)
  const code = img.slot ? item.codes?.[String(img.slot)] : undefined
  const go = (d: number): void => setIndex((i) => Math.min(order.length - 1, Math.max(0, i + d)))
  const next = (): void => {
    if (!advance) return
    // 다음 미선별 그림으로 (없으면 다음 장)
    const rest = order.findIndex((oid, i) => i > index && item.images.find((x) => x.id === oid)?.mark === 'unreviewed')
    if (rest >= 0) setIndex(rest)
    else if (index < order.length - 1) setIndex(index + 1)
  }
  const choose = (m: CurationMark): void => {
    s.setMarks(p.id, key, [img.id], m)
    next()
  }

  return (
    <div className="safe-top fixed inset-0 z-[55] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="그림 선별">
      <header className="flex min-h-12 shrink-0 items-center gap-1 px-1 py-1 text-sm">
        <IconButton label="선별 닫기" onClick={props.onClose}>
          <X size={22} />
        </IconButton>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-semibold text-fg">{props.label}</span>
            <span className="shrink-0 text-[11px] text-dim">
              채택 <b className={counts.adopted >= Math.max(1, props.target) ? 'text-ok' : 'text-fg'}>{counts.adopted}</b>/{props.target}
            </span>
          </span>
          <span className="block truncate font-mono text-[11px] text-dim">
            {index + 1}/{order.length} · seed {img.seed ?? '-'}
            {code ? ` · ${code}` : ''}
          </span>
        </span>
        <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', MARK_STYLE[img.mark])}>
          {CURATION_LABEL[img.mark]}
          {img.slot ? ` ${img.slot}칸` : ''}
        </span>
        <IconButton label="이전 그림" disabled={index === 0} onClick={() => go(-1)}>
          <ChevronLeft size={20} />
        </IconButton>
        <IconButton label="다음 그림" disabled={index >= order.length - 1} onClick={() => go(1)}>
          <ChevronRight size={20} />
        </IconButton>
      </header>
      <div className="relative min-h-0 flex-1">
        {url ? (
          <ZoomImage
            src={url}
            alt={`seed ${img.seed ?? ''}`}
            onSwipe={(d) => go(d)}
            onZoomChange={setZoomed}
            imgStyle={meta && hasAlphaBackground(meta) ? checkerStyle(meta.width, meta.height) : undefined}
          />
        ) : (
          <Thumb meta={meta} className="absolute inset-0 h-full w-full !object-contain" />
        )}
        {zoomed && <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">확대 중</span>}
      </div>
      <div className="safe-bottom shrink-0 border-t border-white/10 bg-panel">
        <div className="flex flex-col gap-2 p-3">
          {showNext && (
            <div role="status" className={cx('flex items-center gap-2 rounded-lg py-1.5 pl-3 pr-1.5', state === 'held' ? 'bg-tag-meta/15' : 'bg-ok/15')}>
              <span className={cx('min-w-0 flex-1 text-xs', state === 'held' ? 'text-tag-meta' : 'text-ok')}>
                {doneText}
                <span className="block text-[11px] text-dim">{leftText}</span>
              </span>
              {props.next && props.onNext ? (
                <Button variant="primary" className="h-10 min-w-0 max-w-[62%] px-3 text-xs" onClick={() => props.onNext!(props.next!.key)}>
                  <span className="truncate">다음: {props.next.label}</span>
                  <ChevronRight size={15} className="shrink-0" />
                </Button>
              ) : (
                <Button variant="default" className="h-10 px-3 text-xs" onClick={props.onClose}>
                  닫기
                </Button>
              )}
            </div>
          )}
          {chain.length > 1 && (
            <div className="scroll-thin flex items-center gap-1 overflow-x-auto text-[11px] text-dim" aria-label="버전">
              {chain.map((v, i) => (
                <span key={v.id} className="flex shrink-0 items-center gap-1">
                  {i > 0 && <span>→</span>}
                  <button
                    type="button"
                    onClick={() => {
                      const at = order.indexOf(v.id)
                      if (at >= 0) setIndex(at)
                    }}
                    className={cx('rounded px-1.5 py-0.5', v.id === img.id ? 'bg-raised text-fg' : '')}
                  >
                    v{v.version ?? i + 1}
                    {v.supersededBy !== undefined ? ' (교체됨)' : ''}
                  </button>
                </span>
              ))}
            </div>
          )}
          <DraftInput
            key={img.id}
            label="설명"
            value={img.description ?? ''}
            placeholder="설명 (목록 파일의 {description}) — 비우면 설명 템플릿"
            onCommit={(t) => s.setDescription(p.id, key, img.id, t)}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              className="px-2 text-xs"
              disabled={representativeOf(item)?.id === img.id && item.representative === img.id}
              onClick={() => s.setRepresentative(p.id, key, img.id)}
            >
              <Star size={14} />
              대표로
            </Button>
            {img.mark !== 'adopted' && adopted.length > 0 && (
              <ReplaceButton
                adopted={adopted}
                codes={item.codes}
                onReplace={(oldId) => {
                  s.replaceAdopted(p.id, key, oldId, img.id)
                  toast('채택 그림을 교체했습니다 — 같은 칸·코드·파일 이름을 이어받습니다')
                }}
              />
            )}
            <label className="ml-auto flex items-center gap-2 text-xs text-dim">
              고르면 다음으로
              <Toggle label="고르면 다음으로" checked={advance} onChange={setAdvance} />
            </label>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Button variant="danger" className="h-14 px-1" onClick={() => choose('rejected')}>
              <X size={18} />
              탈락
            </Button>
            <Button variant="default" className="h-14 px-1" onClick={() => choose('hold')}>
              <Pause size={18} />
              보류
            </Button>
            <Button variant="default" className="h-14 px-1" onClick={() => choose('unreviewed')}>
              <CircleDot size={18} />
              미선별
            </Button>
            <Button variant="primary" className="h-14 px-1" onClick={() => choose('adopted')}>
              <Check size={18} />
              채택
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ReplaceButton(props: { adopted: AssetImage[]; codes?: Record<string, string>; onReplace: (oldId: number) => void }): ReactNode {
  const [pick, setPick] = useState(props.adopted[0].id)
  const name = (a: AssetImage): string => `${a.slot ?? '?'}칸${props.codes?.[String(a.slot)] ? ` ${props.codes[String(a.slot)]}` : ''} v${a.version ?? 1}`
  return (
    <div className="flex items-center gap-1">
      {props.adopted.length > 1 && (
        <Select label="교체할 채택 칸" className="w-32" value={pick} options={props.adopted.map((a) => ({ value: a.id, label: name(a) }))} onChange={setPick} />
      )}
      <Button variant="ghost" className="px-2 text-xs" onClick={() => props.onReplace(props.adopted.length > 1 ? pick : props.adopted[0].id)}>
        <Replace size={14} />
        {props.adopted.length > 1 ? '이 그림으로 교체' : `${name(props.adopted[0])}을 이 그림으로 교체`}
      </Button>
    </div>
  )
}
