import { useRef } from 'react'

const HOLD_MS = 480
const MOVE_TOLERANCE = 10

/**
 * 꾹 누르기 — 손가락(또는 마우스)을 HOLD_MS 동안 거의 움직이지 않고 누르고 있으면 onLongPress.
 * 꾹 누른 뒤 손을 뗄 때 생기는 click은 막아서 "누르면 크게 보기" 같은 동작이 함께 일어나지 않게 한다.
 * 스크롤하려고 끌면 취소된다.
 */
export function useLongPress(
  onLongPress: () => void,
  /** 주면 가로로 밀었을 때 호출: 1 = 왼쪽으로 밂(다음), -1 = 오른쪽으로 밂(이전) */
  onSwipe?: (dir: 1 | -1) => void
): {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: () => void
  onPointerLeave: () => void
  onClickCapture: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
} {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const handler = useRef(onLongPress)
  handler.current = onLongPress
  const swipeHandler = useRef(onSwipe)
  swipeHandler.current = onSwipe

  const cancel = (): void => {
    clearTimeout(timer.current)
    start.current = null
  }
  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      origin.current = { x: e.clientX, y: e.clientY }
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        fired.current = true
        start.current = null
        handler.current()
      }, HOLD_MS)
    },
    onPointerMove: (e) => {
      const s = start.current
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_TOLERANCE) cancel()
    },
    onPointerUp: (e: React.PointerEvent) => {
      cancel()
      const o = origin.current
      origin.current = null
      if (!o || fired.current || !swipeHandler.current) return
      const dx = e.clientX - o.x
      const dy = e.clientY - o.y
      // 가로로 충분히 밀었을 때만 (세로 스크롤·탭과 구분). 뒤따르는 click은 막는다
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        fired.current = true
        swipeHandler.current(dx < 0 ? 1 : -1)
      }
    },
    onPointerCancel: () => {
      cancel()
      origin.current = null
    },
    onPointerLeave: cancel,
    onClickCapture: (e) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    // 브라우저·웹뷰의 기본 길게 누르기 메뉴(이미지 저장 등)는 띄우지 않는다
    onContextMenu: (e) => e.preventDefault()
  }
}
