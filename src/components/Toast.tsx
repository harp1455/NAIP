import { useEffect, type ReactNode } from 'react'
import { cx } from '../lib/util'
import { useToast } from '../stores/toast'

export function Toast(): ReactNode {
  const { text, error, action, seq, hide } = useToast()
  useEffect(() => {
    if (!text) return
    const t = setTimeout(hide, action ? 6000 : error ? 3500 : 2000)
    return () => clearTimeout(t)
  }, [text, seq, error, action, hide])
  if (!text) return null
  return (
    <div className="safe-top pointer-events-none fixed inset-x-0 top-14 z-[70] flex justify-center px-4">
      <div
        key={seq}
        role={error ? 'alert' : 'status'}
        className={cx(
          'sheet-in max-w-full text-[13px] shadow-lg',
          action
            ? 'pointer-events-auto flex items-center gap-1 rounded-2xl py-1 pl-4 pr-1 text-left'
            : 'rounded-full px-4 py-2 text-center',
          error ? 'bg-danger text-white' : 'bg-raised text-fg'
        )}
      >
        <span className="min-w-0">{text}</span>
        {action && (
          <button
            type="button"
            className={cx(
              'h-9 shrink-0 rounded-xl px-3 font-semibold active:bg-black/20',
              error ? 'text-white' : 'text-accent'
            )}
            onClick={() => {
              hide()
              action.run()
            }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}
