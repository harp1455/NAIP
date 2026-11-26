import { useEffect, useRef, type ReactNode } from 'react'

const MAX_SCALE = 8
const DOUBLE_TAP_SCALE = 2.5

/**
 * 손가락으로 확대·이동하는 이미지.
 * - 두 손가락: 벌려서 확대, 함께 움직여 이동 (손가락 사이 지점이 고정된다)
 * - 한 손가락: 확대 중이면 이동, 아니면 좌우로 밀어 앞뒤 이미지 (onSwipe)
 * - 두 번 탭: 그 자리를 확대하거나 원래 크기로
 * - 마우스 휠: 커서 자리 기준 확대
 * 움직이는 동안에는 React를 거치지 않고 transform만 바꿔 끊김을 줄인다.
 */
export function ZoomImage(props: {
  src: string
  alt: string
  /** 확대하지 않은 상태에서 가로로 밀었을 때: 1 = 다음(왼쪽으로 밂), -1 = 이전 */
  onSwipe: (dir: 1 | -1) => void
  onZoomChange: (zoomed: boolean) => void
}): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const view = useRef({ s: 1, x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; qx: number; qy: number; s: number } | null>(null)
  const single = useRef<{ startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  const lastTap = useRef(0)
  const handlers = useRef(props)
  handlers.current = props

  const apply = (animate = false): void => {
    const el = img.current
    const b = box.current
    if (!el || !b) return
    const v = view.current
    if (v.s < 1.02) {
      v.s = 1
      v.x = 0
      v.y = 0
    } else {
      // 그림이 화면 밖으로 완전히 나가지 않게 이동 범위를 제한한다
      const mx = ((v.s - 1) * b.clientWidth) / 2
      const my = ((v.s - 1) * b.clientHeight) / 2
      v.x = Math.min(mx, Math.max(-mx, v.x))
      v.y = Math.min(my, Math.max(-my, v.y))
    }
    el.style.transition = animate ? 'transform 0.18s ease-out' : 'none'
    el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`
    handlers.current.onZoomChange(v.s > 1)
  }

  /** 화면 좌표 (px, py) 아래의 그림 지점이 그대로 있도록 배율을 바꾼다 */
  const zoomAt = (px: number, py: number, scale: number, animate = false): void => {
    const b = box.current
    if (!b) return
    const r = b.getBoundingClientRect()
    const cx = px - r.left - r.width / 2
    const cy = py - r.top - r.height / 2
    const v = view.current
    const next = Math.min(MAX_SCALE, Math.max(1, scale))
    const qx = (cx - v.x) / v.s
    const qy = (cy - v.y) / v.s
    view.current = { s: next, x: cx - next * qx, y: cy - next * qy }
    apply(animate)
  }

  // 휠 확대는 기본 스크롤을 막아야 해서 passive가 아닌 리스너로 건다
  useEffect(() => {
    const b = box.current
    if (!b) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, view.current.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2))
    }
    b.addEventListener('wheel', onWheel, { passive: false })
    return () => b.removeEventListener('wheel', onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startPinch = (): void => {
    const b = box.current
    const [a, c] = [...pointers.current.values()]
    if (!b || !a || !c) return
    const r = b.getBoundingClientRect()
    const mx = (a.x + c.x) / 2 - r.left - r.width / 2
    const my = (a.y + c.y) / 2 - r.top - r.height / 2
    const v = view.current
    pinch.current = {
      dist: Math.max(1, Math.hypot(a.x - c.x, a.y - c.y)),
      qx: (mx - v.x) / v.s,
      qy: (my - v.y) / v.s,
      s: v.s
    }
    single.current = null
  }

  return (
    <div
      ref={box}
      className="absolute inset-0 touch-none overflow-hidden"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pointers.current.size === 2) startPinch()
        else if (pointers.current.size === 1) {
          single.current = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false }
        }
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const b = box.current
        if (!b) return
        if (pinch.current && pointers.current.size >= 2) {
          const [a, c] = [...pointers.current.values()]
          const r = b.getBoundingClientRect()
          const mx = (a.x + c.x) / 2 - r.left - r.width / 2
          const my = (a.y + c.y) / 2 - r.top - r.height / 2
          const p = pinch.current
          const s = Math.min(MAX_SCALE, Math.max(1, (p.s * Math.hypot(a.x - c.x, a.y - c.y)) / p.dist))
          view.current = { s, x: mx - s * p.qx, y: my - s * p.qy }
          apply()
          return
        }
        const one = single.current
        if (!one) return
        if (Math.hypot(e.clientX - one.startX, e.clientY - one.startY) > 8) one.moved = true
        if (view.current.s > 1) {
          view.current.x += e.clientX - one.lastX
          view.current.y += e.clientY - one.lastY
          apply()
        }
        one.lastX = e.clientX
        one.lastY = e.clientY
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId)
        if (pinch.current) {
          // 한 손가락이 남으면 그 손가락으로 이어서 이동할 수 있게 한다
          pinch.current = null
          const rest = [...pointers.current.values()][0]
          single.current = rest
            ? { startX: rest.x, startY: rest.y, lastX: rest.x, lastY: rest.y, moved: true }
            : null
          apply()
          return
        }
        const one = single.current
        single.current = null
        if (!one) return
        const dx = e.clientX - one.startX
        const dy = e.clientY - one.startY
        if (!one.moved) {
          const now = Date.now()
          if (now - lastTap.current < 300) {
            lastTap.current = 0
            zoomAt(e.clientX, e.clientY, view.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, true)
          } else {
            lastTap.current = now
          }
          return
        }
        // 확대하지 않은 상태에서 가로로 충분히 밀면 앞뒤 이미지로
        if (view.current.s === 1 && Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          handlers.current.onSwipe(dx < 0 ? 1 : -1)
        }
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId)
        pinch.current = null
        single.current = null
      }}
    >
      <img
        ref={img}
        src={props.src}
        alt={props.alt}
        draggable={false}
        className="h-full w-full select-none object-contain will-change-transform"
      />
    </div>
  )
}
