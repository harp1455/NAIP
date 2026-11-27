import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Brush,
  Eraser,
  Eye,
  FlipVertical2,
  Maximize,
  Minus,
  PaintBucket,
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
  FolderOpen
} from 'lucide-react'
import { canvasOf, loadImage, pngDataUrl } from '../lib/image'
import { alphaToMask, dilate, erode, invert, maskCoverage, maskToRgba } from '../lib/mask'
import { clamp, cx } from '../lib/util'
import { useMasks } from '../stores/masks'
import { Button, IconButton, Sheet } from './ui'

/**
 * 인페인트 마스크 편집기.
 * - 마스크는 원본 해상도(width×height)의 캔버스에 그린다. 화면 표시는 CSS 변환(확대·이동)만 하므로
 *   좌표는 언제나 "표시된 캔버스 사각형 → 원본 픽셀"로 바꿔 계산해 확대율·기기 밀도와 상관없이 정확하다.
 * - 한 손가락 = 칠하기, 두 손가락 = 확대·이동 (두 번째 손가락이 닿으면 그리던 획은 취소).
 * - 되돌리기는 동작 기록을 처음부터 다시 그리는 방식이라 단계 수 제한이 없고 메모리를 적게 쓴다
 *   (NAIS3 mask-workspace의 동작 재생 방식).
 */

type Point = { x: number; y: number }
type Action =
  | { type: 'stroke'; erase: boolean; size: number; points: Point[] }
  | { type: 'fill' }
  | { type: 'clear' }
  | { type: 'invert' }
  | { type: 'grow'; px: number }
  | { type: 'load'; image: HTMLImageElement }

const COLORS = ['#e8914f', '#e5645a', '#3d8bff', '#3fc47a', '#c24dff', '#ffffff']
const MAX_SCALE = 16
/** 확장·축소 한 번의 크기 — NovelAI 마스크는 8px 블록 단위로 정리된다 */
const GROW_STEP = 8

export function MaskEditor(props: {
  image: string
  width: number
  height: number
  mask: string | null
  onSave: (mask: string | null) => void
  onClose: () => void
}): ReactNode {
  const W = props.width
  const H = props.height
  const stage = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const display = useRef<HTMLCanvasElement>(null)
  /** 실제 마스크 (흰색 + 알파). 표시용 캔버스는 이것을 고른 색으로 칠해 보여 준다 */
  const mask = useRef<HTMLCanvasElement>(null as unknown as HTMLCanvasElement)
  if (!mask.current) mask.current = canvasOf(W, H)[0]

  const actions = useRef<Action[]>([])
  const index = useRef(0)
  const base = useRef<HTMLImageElement | null>(null)
  const [, bump] = useState(0)
  const rerender = (): void => bump((n) => n + 1)

  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [size, setSize] = useState(() => clamp(Math.round(Math.max(W, H) / 20), 1, 400))
  const [color, setColor] = useState(COLORS[0])
  const [opacity, setOpacity] = useState(0.55)
  const [peek, setPeek] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [fit, setFit] = useState({ w: 0, h: 0 })
  const view = useRef({ s: 1, x: 0, y: 0 })
  const [cursor, setCursor] = useState<{ x: number; y: number; d: number } | null>(null)

  // ── 그리기 ──────────────────────────────────────────────
  const strokeOn = (ctx: CanvasRenderingContext2D, a: Extract<Action, { type: 'stroke' }>, from = 0): void => {
    ctx.save()
    ctx.globalCompositeOperation = a.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = ctx.fillStyle = '#ffffff'
    ctx.lineWidth = a.size
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const pts = a.points
    if (pts.length === 1 || from >= pts.length - 1) {
      const p = pts[pts.length - 1]
      // 1px 브러시는 정확히 한 픽셀을 칠한다 (원으로 그리면 반투명 경계가 생긴다)
      if (a.size <= 2) ctx.fillRect(Math.floor(p.x - a.size / 2 + 0.5), Math.floor(p.y - a.size / 2 + 0.5), a.size, a.size)
      else {
        ctx.beginPath()
        ctx.arc(p.x, p.y, a.size / 2, 0, Math.PI * 2)
        ctx.fill()
      }
    } else {
      ctx.beginPath()
      ctx.moveTo(pts[from].x, pts[from].y)
      for (let i = from + 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** 픽셀 단위 연산(반전·확장·축소)은 0/1 배열로 바꿔 계산한다 */
  const pixelOp = (ctx: CanvasRenderingContext2D, fn: (m: Uint8Array) => Uint8Array): void => {
    const data = ctx.getImageData(0, 0, W, H)
    maskToRgba(fn(alphaToMask(data.data)), data.data)
    ctx.putImageData(data, 0, 0)
  }

  const apply = (ctx: CanvasRenderingContext2D, a: Action): void => {
    if (a.type === 'stroke') strokeOn(ctx, a)
    else if (a.type === 'fill') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)
    } else if (a.type === 'clear') ctx.clearRect(0, 0, W, H)
    else if (a.type === 'invert') pixelOp(ctx, invert)
    else if (a.type === 'grow') pixelOp(ctx, (m) => (a.px > 0 ? dilate(m, W, H, a.px) : erode(m, W, H, -a.px)))
    else if (a.type === 'load') {
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(a.image, 0, 0, W, H)
      // 불러온 마스크는 흰색 + 이진 알파로 정리한다
      pixelOp(ctx, (m) => m)
    }
  }

  /** 마스크를 고른 색으로 표시 캔버스에 옮긴다 */
  const paintDisplay = useCallback((): void => {
    const d = display.current?.getContext('2d')
    if (!d) return
    d.globalCompositeOperation = 'source-over'
    d.clearRect(0, 0, W, H)
    d.drawImage(mask.current, 0, 0)
    d.globalCompositeOperation = 'source-in'
    d.fillStyle = color
    d.fillRect(0, 0, W, H)
    d.globalCompositeOperation = 'source-over'
  }, [color, W, H])

  /** 처음(불러온 마스크)부터 index까지의 동작을 다시 그린다 */
  const replay = useCallback((): void => {
    const ctx = mask.current.getContext('2d', { willReadFrequently: true })!
    ctx.clearRect(0, 0, W, H)
    if (base.current) {
      ctx.drawImage(base.current, 0, 0, W, H)
      pixelOp(ctx, (m) => m)
    }
    for (let i = 0; i < index.current; i++) apply(ctx, actions.current[i])
    paintDisplay()
  }, [W, H, paintDisplay]) // eslint-disable-line react-hooks/exhaustive-deps

  const push = (a: Action): void => {
    actions.current = actions.current.slice(0, index.current)
    actions.current.push(a)
    index.current = actions.current.length
    const ctx = mask.current.getContext('2d', { willReadFrequently: true })!
    apply(ctx, a)
    paintDisplay()
    rerender()
  }

  // 기존 마스크 불러오기
  useEffect(() => {
    let live = true
    if (props.mask) {
      void loadImage(props.mask).then((img) => {
        if (!live) return
        base.current = img
        replay()
      })
    } else replay()
    return () => {
      live = false
    }
  }, [props.mask]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => paintDisplay(), [paintDisplay])

  // ── 화면 맞춤·확대 ─────────────────────────────────────────
  const applyView = (): void => {
    const el = content.current
    const b = stage.current
    if (!el || !b) return
    const v = view.current
    if (v.s <= 1.001) {
      v.s = 1
      v.x = 0
      v.y = 0
    } else {
      const mx = ((v.s - 1) * fitRef.current.w) / 2 + fitRef.current.w * 0.25
      const my = ((v.s - 1) * fitRef.current.h) / 2 + fitRef.current.h * 0.25
      v.x = clamp(v.x, -mx, mx)
      v.y = clamp(v.y, -my, my)
    }
    el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`
  }
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const el = stage.current!
    const measure = (): void => {
      const scale = Math.min(el.clientWidth / W, el.clientHeight / H)
      setFit({ w: Math.max(1, Math.floor(W * scale)), h: Math.max(1, Math.floor(H * scale)) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, H])

  const zoomAt = (px: number, py: number, scale: number): void => {
    const b = stage.current
    if (!b) return
    const r = b.getBoundingClientRect()
    const cx0 = px - r.left - r.width / 2
    const cy0 = py - r.top - r.height / 2
    const v = view.current
    const next = clamp(scale, 1, MAX_SCALE)
    const qx = (cx0 - v.x) / v.s
    const qy = (cy0 - v.y) / v.s
    view.current = { s: next, x: cx0 - next * qx, y: cy0 - next * qy }
    applyView()
    rerender()
  }

  useEffect(() => {
    const b = stage.current
    if (!b) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, view.current.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2))
    }
    b.addEventListener('wheel', onWheel, { passive: false })
    return () => b.removeEventListener('wheel', onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 손가락 처리 ───────────────────────────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drawing = useRef<{ action: Extract<Action, { type: 'stroke' }>; startedAt: number } | null>(null)
  const pinch = useRef<{ dist: number; qx: number; qy: number; s: number } | null>(null)

  /** 화면 좌표 → 원본 픽셀 좌표 (표시 캔버스의 실제 사각형 기준이라 확대·이동이 자동 반영된다) */
  const toImage = (clientX: number, clientY: number): Point => {
    const r = display.current!.getBoundingClientRect()
    return {
      x: clamp(((clientX - r.left) / r.width) * W, 0, W),
      y: clamp(((clientY - r.top) / r.height) * H, 0, H)
    }
  }
  const showCursor = (clientX: number, clientY: number): void => {
    const r = display.current!.getBoundingClientRect()
    const sr = stage.current!.getBoundingClientRect()
    setCursor({ x: clientX - sr.left, y: clientY - sr.top, d: (size * r.width) / W })
  }

  const startPinch = (): void => {
    const [a, c] = [...pointers.current.values()]
    const r = stage.current!.getBoundingClientRect()
    const mx = (a.x + c.x) / 2 - r.left - r.width / 2
    const my = (a.y + c.y) / 2 - r.top - r.height / 2
    const v = view.current
    pinch.current = { dist: Math.max(1, Math.hypot(a.x - c.x, a.y - c.y)), qx: (mx - v.x) / v.s, qy: (my - v.y) / v.s, s: v.s }
  }

  const onDown = (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      // 두 번째 손가락: 그리던 획을 없던 일로 하고 확대·이동으로 바꾼다
      if (drawing.current) {
        drawing.current = null
        replay()
      }
      setCursor(null)
      startPinch()
      return
    }
    if (pointers.current.size > 2) return
    const p = toImage(e.clientX, e.clientY)
    const action: Extract<Action, { type: 'stroke' }> = { type: 'stroke', erase: tool === 'eraser', size, points: [p] }
    drawing.current = { action, startedAt: performance.now() }
    strokeOn(mask.current.getContext('2d', { willReadFrequently: true })!, action)
    paintDisplay()
    showCursor(e.clientX, e.clientY)
  }

  const onMove = (e: React.PointerEvent): void => {
    if (!pointers.current.has(e.pointerId)) {
      if (e.pointerType === 'mouse') showCursor(e.clientX, e.clientY)
      return
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size >= 2) {
      const [a, c] = [...pointers.current.values()]
      const r = stage.current!.getBoundingClientRect()
      const mx = (a.x + c.x) / 2 - r.left - r.width / 2
      const my = (a.y + c.y) / 2 - r.top - r.height / 2
      const p = pinch.current
      const s = clamp((p.s * Math.hypot(a.x - c.x, a.y - c.y)) / p.dist, 1, MAX_SCALE)
      view.current = { s, x: mx - s * p.qx, y: my - s * p.qy }
      applyView()
      return
    }
    const d = drawing.current
    if (!d) return
    const pts = d.action.points
    const p = toImage(e.clientX, e.clientY)
    const last = pts[pts.length - 1]
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return
    pts.push(p)
    strokeOn(mask.current.getContext('2d', { willReadFrequently: true })!, d.action, pts.length - 2)
    paintDisplay()
    showCursor(e.clientX, e.clientY)
  }

  const onUp = (e: React.PointerEvent): void => {
    pointers.current.delete(e.pointerId)
    if (pinch.current) {
      if (pointers.current.size < 2) {
        pinch.current = null
        rerender()
      }
      return
    }
    const d = drawing.current
    drawing.current = null
    setCursor(null)
    if (!d) return
    // 이미 마스크 캔버스에 그렸으므로 기록만 남긴다
    actions.current = actions.current.slice(0, index.current)
    actions.current.push(d.action)
    index.current = actions.current.length
    rerender()
  }

  // ── 동작 ────────────────────────────────────────────────
  const undo = (): void => {
    if (index.current <= 0) return
    index.current--
    replay()
    rerender()
  }
  const redo = (): void => {
    if (index.current >= actions.current.length) return
    index.current++
    replay()
    rerender()
  }
  const exportMask = (): string | null => {
    const data = mask.current.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H)
    return maskCoverage(alphaToMask(data.data)) > 0 ? mask.current.toDataURL('image/png') : null
  }
  const save = (): void => {
    props.onSave(exportMask())
    props.onClose()
  }
  const saveToLibrary = (): void => {
    const data = exportMask()
    if (!data) return
    const name = window.prompt('마스크 이름', `마스크 ${new Date().toLocaleTimeString('ko-KR')}`)
    if (name === null) return
    useMasks.getState().add({ name: name.trim() || '마스크', width: W, height: H, data })
  }

  const zoomed = view.current.s > 1

  const tb = 'flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-xs'
  return (
    <Sheet
      title="인페인트 마스크"
      onClose={props.onClose}
      flush
      actions={
        <button
          type="button"
          className="flex h-10 items-center gap-1 rounded-lg px-2 text-xs text-dim active:bg-raised"
          onPointerDown={() => setPeek(true)}
          onPointerUp={() => setPeek(false)}
          onPointerLeave={() => setPeek(false)}
          onContextMenu={(e) => e.preventDefault()}
          title="누르고 있는 동안 원본만 보기"
        >
          <Eye size={16} />
          원본
        </button>
      }
      footer={
        <>
          <Button onClick={props.onClose}>취소</Button>
          <Button variant="primary" className="flex-1" onClick={save}>
            마스크 적용
          </Button>
        </>
      }
    >
      <div className="flex h-full flex-col">
        <div
          ref={stage}
          className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-black"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={(e) => e.pointerType === 'mouse' && !pointers.current.size && setCursor(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            ref={content}
            className="relative shrink-0 will-change-transform"
            style={{ width: fit.w, height: fit.h, transformOrigin: 'center center' }}
          >
            <img
              src={pngDataUrl(props.image)}
              alt="인페인트 원본"
              draggable={false}
              className="absolute inset-0 h-full w-full select-none"
              style={{ imageRendering: zoomed ? 'pixelated' : 'auto' }}
            />
            <canvas
              ref={display}
              width={W}
              height={H}
              aria-label="마스크"
              className="absolute inset-0 h-full w-full"
              style={{ opacity: peek ? 0 : opacity, imageRendering: 'pixelated' }}
            />
          </div>
          {cursor && (
            <div
              className="pointer-events-none absolute rounded-full border border-white mix-blend-difference"
              style={{
                left: cursor.x - cursor.d / 2,
                top: cursor.y - cursor.d / 2,
                width: Math.max(2, cursor.d),
                height: Math.max(2, cursor.d)
              }}
            />
          )}
          <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white">
            {W}×{H} · {Math.round(view.current.s * 100)}%
          </span>
          {zoomed && (
            <button
              type="button"
              aria-label="화면에 맞추기"
              className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                view.current = { s: 1, x: 0, y: 0 }
                applyView()
                rerender()
              }}
            >
              <Maximize size={16} />
            </button>
          )}
        </div>

        <div className="shrink-0 border-t border-line">
          {/* 1줄: 도구·크기 */}
          <div className="flex items-center gap-1 px-2 pt-1.5">
            <IconButton label="브러시" active={tool === 'brush'} onClick={() => setTool('brush')}>
              <Brush size={18} />
            </IconButton>
            <IconButton label="지우개" active={tool === 'eraser'} onClick={() => setTool('eraser')}>
              <Eraser size={18} />
            </IconButton>
            <input
              type="range"
              aria-label="브러시 크기"
              className="mx-1 h-8 min-w-0 flex-1"
              min={1}
              max={Math.max(64, Math.round(Math.max(W, H) / 3))}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
            <input
              aria-label="브러시 크기 (픽셀)"
              inputMode="numeric"
              value={size}
              onChange={(e) => setSize(clamp(Number(e.target.value.replace(/\D/g, '')) || 1, 1, 1024))}
              className="h-9 w-14 rounded-md border border-line bg-field text-center font-mono text-sm"
            />
            <span className="text-[11px] text-dim">px</span>
          </div>
          {/* 2줄: 편집 동작 */}
          <div className="scroll-thin flex items-center gap-1 overflow-x-auto px-2 py-1.5">
            <IconButton label="되돌리기" disabled={index.current === 0} onClick={undo}>
              <Undo2 size={18} />
            </IconButton>
            <IconButton label="다시 하기" disabled={index.current >= actions.current.length} onClick={redo}>
              <Redo2 size={18} />
            </IconButton>
            <span className="mx-0.5 h-6 w-px shrink-0 bg-line" />
            <button type="button" className={cx(tb, 'active:bg-raised')} onClick={() => push({ type: 'fill' })}>
              <PaintBucket size={16} />
              전체
            </button>
            <button type="button" className={cx(tb, 'active:bg-raised')} onClick={() => push({ type: 'clear' })}>
              <Trash2 size={16} />
              해제
            </button>
            <button type="button" className={cx(tb, 'active:bg-raised')} onClick={() => push({ type: 'invert' })}>
              <FlipVertical2 size={16} />
              반전
            </button>
            <button
              type="button"
              className={cx(tb, 'active:bg-raised')}
              title={`칠한 영역을 ${GROW_STEP}px 넓힙니다`}
              onClick={() => push({ type: 'grow', px: GROW_STEP })}
            >
              <Plus size={16} />
              확장
            </button>
            <button
              type="button"
              className={cx(tb, 'active:bg-raised')}
              title={`칠한 영역을 ${GROW_STEP}px 좁힙니다`}
              onClick={() => push({ type: 'grow', px: -GROW_STEP })}
            >
              <Minus size={16} />
              축소
            </button>
            <span className="mx-0.5 h-6 w-px shrink-0 bg-line" />
            <button type="button" className={cx(tb, 'active:bg-raised')} onClick={saveToLibrary}>
              <Save size={16} />
              보관
            </button>
            <button type="button" className={cx(tb, 'active:bg-raised')} onClick={() => setLibraryOpen(true)}>
              <FolderOpen size={16} />
              불러오기
            </button>
          </div>
          {/* 3줄: 표시 */}
          <div className="flex items-center gap-1.5 px-3 pb-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`마스크 색 ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cx('h-6 w-6 shrink-0 rounded-full border-2', color === c ? 'border-white' : 'border-transparent')}
                style={{ background: c }}
              />
            ))}
            <span className="ml-2 shrink-0 text-[11px] text-dim">투명도</span>
            <input
              type="range"
              aria-label="마스크 투명도"
              className="h-8 min-w-0 flex-1"
              min={10}
              max={95}
              value={Math.round(opacity * 100)}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
            />
          </div>
        </div>
      </div>
      {libraryOpen && (
        <MaskLibrary
          width={W}
          height={H}
          onPick={(img) => {
            push({ type: 'load', image: img })
            setLibraryOpen(false)
          }}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </Sheet>
  )
}

/** 보관한 마스크 목록 — 고르면 지금 그림 크기에 맞춰 늘려 불러온다 */
function MaskLibrary(props: {
  width: number
  height: number
  onPick: (img: HTMLImageElement) => void
  onClose: () => void
}): ReactNode {
  const { masks, remove } = useMasks()
  return (
    <Sheet title="보관한 마스크" onClose={props.onClose}>
      {masks.length === 0 ? (
        <p className="py-8 text-center text-sm text-dim">보관한 마스크가 없습니다. 편집기의 "보관"으로 저장하세요.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {masks.map((m) => {
            const sameRatio = Math.abs(m.width / m.height - props.width / props.height) < 0.01
            return (
              <li key={m.id} className="rounded-lg border border-line bg-field p-1.5">
                <button
                  type="button"
                  className="block w-full"
                  onClick={() => void loadImage(m.data).then(props.onPick)}
                >
                  <span
                    className="block w-full rounded bg-[repeating-conic-gradient(#222_0_25%,#2c2c2c_0_50%)] bg-[length:12px_12px]"
                    style={{ aspectRatio: `${m.width} / ${m.height}` }}
                  >
                    <img src={m.data} alt="" className="h-full w-full object-contain" />
                  </span>
                  <span className="mt-1 block truncate text-xs">{m.name}</span>
                  <span className={cx('block font-mono text-[10px]', sameRatio ? 'text-dim' : 'text-accent')}>
                    {m.width}×{m.height}
                    {sameRatio ? '' : ' · 비율 다름'}
                  </span>
                </button>
                <button
                  type="button"
                  className="mt-1 h-7 w-full rounded text-[11px] text-danger active:bg-raised"
                  onClick={() => window.confirm(`"${m.name}" 마스크를 지울까요?`) && remove(m.id)}
                >
                  삭제
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}
