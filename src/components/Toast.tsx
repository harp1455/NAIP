import { useEffect, type ReactNode } from 'react'
import { cx } from '../lib/util'
import { useToast } from '../stores/toast'

export function Toast(): ReactNode {
  const { text, error, seq, hide } = useToast()
  useEffect(() => {
    if (!text) return
    const t = setTimeout(hide, error ? 3500 : 2000)
    return () => clearTimeout(t)
  }, [text, seq, error, hide])
  if (!text) return null
  return (
    <div className="safe-top pointer-events-none fixed inset-x-0 top-14 z-[70] flex justify-center px-4">
      <div
        key={seq}
        role={error ? 'alert' : 'status'}
        className={cx(
          'sheet-in max-w-full rounded-full px-4 py-2 text-center text-[13px] shadow-lg',
          error ? 'bg-danger text-white' : 'bg-raised text-fg'
        )}
      >
        {text}
      </div>
    </div>
  )
}
