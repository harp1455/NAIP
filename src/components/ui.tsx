import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Minus, Plus, X } from 'lucide-react'
import { useBackClose } from '../lib/back'
import { clamp, cx } from '../lib/util'

export function Sheet(props: {
  title: ReactNode
  onClose: () => void
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
  /** 본문 패딩 제거 (캔버스 등) */
  flush?: boolean
}): ReactNode {
  useBackClose(props.onClose)
  return (
    <div
      className="sheet-overlay fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="sheet-in safe-top flex h-full w-full flex-col bg-panel sm:h-[min(90vh,820px)] sm:max-w-xl sm:rounded-2xl sm:border sm:border-line"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{props.title}</h2>
          {props.actions}
          <IconButton label="닫기" onClick={props.onClose}>
            <X size={20} />
          </IconButton>
        </header>
        <div className={cx('scroll-thin min-h-0 flex-1 overflow-y-auto', !props.flush && 'p-3')}>
          {props.children}
        </div>
        {props.footer && (
          <footer className="safe-bottom shrink-0 border-t border-line">
            <div className="flex gap-2 p-3">{props.footer}</div>
          </footer>
        )}
      </div>
    </div>
  )
}

export function IconButton(props: {
  label: string
  onClick?: () => void
  children: ReactNode
  active?: boolean
  disabled?: boolean
  className?: string
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg active:bg-raised',
        props.active ? 'bg-raised text-accent' : 'text-dim hover:text-fg',
        props.className
      )}
    >
      {props.children}
    </button>
  )
}

export function Button(props: {
  onClick?: () => void
  children: ReactNode
  variant?: 'primary' | 'ghost' | 'danger' | 'default'
  disabled?: boolean
  className?: string
}): ReactNode {
  const v = props.variant ?? 'default'
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        'flex h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-medium',
        v === 'primary' && 'bg-accent text-accent-fg active:brightness-90',
        v === 'default' && 'bg-raised text-fg active:brightness-125',
        v === 'ghost' && 'text-dim hover:text-fg active:bg-raised',
        v === 'danger' && 'bg-danger/15 text-danger active:bg-danger/25',
        props.className
      )}
    >
      {props.children}
    </button>
  )
}

/** 접을 수 있는 구역 (스크린샷의 "고정 ^" 헤더) */
export function Section(props: {
  title: string
  right?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  return (
    <section>
      <div className="flex h-8 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-8 items-center gap-1 pr-2 text-xs text-dim"
        >
          {props.title}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs">{props.right}</div>
      </div>
      {open && props.children}
    </section>
  )
}

export function Toggle(props: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={cx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors',
        props.checked ? 'bg-accent' : 'bg-raised'
      )}
    >
      <span
        className={cx(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
          props.checked ? 'left-[22px]' : 'left-0.5'
        )}
      />
    </button>
  )
}

export function Row(props: { label: ReactNode; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-12 items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{props.label}</div>
        {props.hint && <div className="mt-0.5 text-xs text-dim">{props.hint}</div>}
      </div>
      {props.children}
    </div>
  )
}

export function SliderRow(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  disabled?: boolean
}): ReactNode {
  return (
    <label className="block py-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span>{props.label}</span>
        <span className="font-mono text-xs tabular-nums text-dim">
          {props.format ? props.format(props.value) : props.value}
        </span>
      </div>
      <input
        type="range"
        className="mt-1 h-8 w-full"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function Select<T extends string | number>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  className?: string
  disabled?: boolean
}): ReactNode {
  const numeric = typeof props.value === 'number'
  return (
    <div className={cx('relative', props.className)}>
      <select
        aria-label={props.label}
        value={String(props.value)}
        disabled={props.disabled}
        onChange={(e) => props.onChange((numeric ? Number(e.target.value) : e.target.value) as T)}
        className="h-11 w-full appearance-none truncate rounded-lg border border-line bg-field pl-3 pr-8 text-sm text-fg"
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-dim"
      />
    </div>
  )
}

export function Stepper(props: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}): ReactNode {
  const set = (v: number): void => props.onChange(clamp(Math.round(v) || props.min, props.min, props.max))
  return (
    <div className="flex h-11 items-center rounded-lg border border-line bg-field">
      <button
        type="button"
        aria-label={`${props.label} 줄이기`}
        className="flex h-full w-10 items-center justify-center text-dim active:text-fg"
        onClick={() => set(props.value - 1)}
      >
        <Minus size={16} />
      </button>
      <input
        aria-label={props.label}
        inputMode="numeric"
        className="w-10 bg-transparent text-center font-mono text-sm tabular-nums outline-none"
        value={props.value}
        onChange={(e) => set(Number(e.target.value.replace(/\D/g, '')))}
      />
      <button
        type="button"
        aria-label={`${props.label} 늘리기`}
        className="flex h-full w-10 items-center justify-center text-dim active:text-fg"
        onClick={() => set(props.value + 1)}
      >
        <Plus size={16} />
      </button>
    </div>
  )
}

/** 프롬프트용 여러 줄 입력 — 가중치 색상 표시와 태그 자동완성이 붙은 에디터 */
export { PromptEditor as TextArea } from './PromptEditor'

export function TextInput(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  label: string
  type?: string
  inputMode?: 'numeric' | 'text'
  className?: string
}): ReactNode {
  return (
    <input
      aria-label={props.label}
      type={props.type ?? 'text'}
      inputMode={props.inputMode}
      value={props.value}
      placeholder={props.placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => props.onChange(e.target.value)}
      className={cx(
        'h-11 w-full rounded-lg border border-line bg-field px-3 text-sm text-fg placeholder:text-dim/60',
        props.className
      )}
    />
  )
}

export function Empty(props: { children: ReactNode }): ReactNode {
  return <div className="px-4 py-10 text-center text-sm text-dim">{props.children}</div>
}
