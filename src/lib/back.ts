import { useEffect, useRef } from 'react'

/** 열려 있는 시트/뷰어의 닫기 핸들러 스택 — 안드로이드 뒤로가기가 맨 위부터 닫는다 */
const stack: (() => void)[] = []

export function closeTop(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top()
  return true
}

export function useBackClose(onClose: () => void): void {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const handler = (): void => ref.current()
    stack.push(handler)
    return () => {
      const i = stack.lastIndexOf(handler)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [])
}
