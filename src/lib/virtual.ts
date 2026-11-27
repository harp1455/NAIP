import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface VirtualGrid {
  /** 스크롤되는 상자에 붙인다 */
  ref: RefObject<HTMLDivElement | null>
  cols: number
  /** 칸 한 변 (px) */
  size: number
  /** 그릴 칸 범위 [start, end) */
  start: number
  end: number
  /** 목록 전체 높이 (px) */
  height: number
  /** i번째 칸의 위치 */
  pos: (i: number) => { top: number; left: number }
  /** 끝 근처까지 내려왔는지 — 다음 페이지를 읽을 때 */
  nearEnd: boolean
}

/**
 * 정사각형 칸 격자의 가상 스크롤 — 화면에 보이는 줄(과 위아래 몇 줄)만 그린다.
 * `grid-cols-[repeat(auto-fill,minmax(min,1fr))]`와 같은 규칙으로 열 수·칸 크기를 정해 겉모습은 예전 격자와 같다.
 */
export function useVirtualGrid(count: number, opts: { min: number; gap: number; overscan?: number }): VirtualGrid {
  const ref = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const overscan = opts.overscan ?? 3

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const style = getComputedStyle(el)
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      setBox((b) => (b.width === width && b.height === el.clientHeight ? b : { width, height: el.clientHeight }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setScrollTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const { gap, min } = opts
  const width = Math.max(0, box.width)
  const cols = Math.max(1, Math.floor((width + gap) / (min + gap)))
  const size = width > 0 ? (width - gap * (cols - 1)) / cols : min
  const rowH = size + gap
  const rows = Math.ceil(count / cols)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + box.height) / rowH) + overscan)
  return {
    ref,
    cols,
    size,
    start: Math.min(count, firstRow * cols),
    end: Math.min(count, (lastRow + 1) * cols),
    height: rows > 0 ? rows * rowH - gap : 0,
    pos: (i) => ({ top: Math.floor(i / cols) * rowH, left: (i % cols) * (size + gap) }),
    nearEnd: rows === 0 || lastRow >= rows - 1 - overscan * 2
  }
}

/** 값이 바뀌면 스크롤을 맨 위로 (필터·검색이 바뀔 때) */
export function useScrollReset(ref: RefObject<HTMLDivElement | null>, key: unknown): void {
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}
