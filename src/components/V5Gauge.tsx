import { useEffect, useState, type ReactNode } from 'react'
import type { OpusUsageStatus } from '../nai/types'
import { cx } from '../lib/util'
import { useSettings } from '../stores/settings'

/** 남은 V5 할당량(%). 소진 상태면 0. 부스트 중에는 100을 넘을 수 있다 */
export function usagePercent(usage: OpusUsageStatus): number {
  return usage.isNegative ? 0 : Math.max(0, usage.percent)
}

/** 부스트로 산 추가 할당량(%) — 기본 할당량을 다 쓴 뒤에 쓰인다 */
export function boostPercent(usage: OpusUsageStatus): number {
  return Math.max(0, usage.purchasedPercent ?? 0)
}

/** 하루 충전량(%). 1%가 차는 데 걸리는 초를 하루로 환산하며, 0이면 충전이 멈춘 상태 */
export function refillPerDay(usage: OpusUsageStatus): number {
  return usage.timeUntilNextPercent <= 0 ? 0 : Math.round((86400 / usage.timeUntilNextPercent) * 10) / 10
}

/**
 * 할당량이 100%로 다 차는 시각. 서버는 "초기화 시각"을 따로 주지 않고 1%가 차는 데 걸리는 시간만 알려 주므로
 * (한 번에 초기화되는 것이 아니라 조금씩 계속 찬다) 남은 %만큼 곱해서 구한다. 이미 가득이거나 충전이 멈췄으면 null.
 */
export function fullAt(usage: OpusUsageStatus, fetchedAt: number): number | null {
  const percent = usagePercent(usage)
  if (percent >= 100 || usage.timeUntilNextPercent <= 0 || !fetchedAt) return null
  return fetchedAt + (100 - percent) * usage.timeUntilNextPercent * 1000
}

/** "2일 15시간" 같은 남은 시간 표기 */
export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min < 60) return `${min}분`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}시간${min % 60 ? ` ${min % 60}분` : ''}`
  return `${Math.floor(hours / 24)}일${hours % 24 ? ` ${hours % 24}시간` : ''}`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function tone(percent: number): { bar: string; text: string } {
  if (percent <= 20) return { bar: 'bg-danger', text: 'text-danger' }
  if (percent <= 50) return { bar: 'bg-accent', text: 'text-accent' }
  return { bar: 'bg-ok', text: 'text-ok' }
}

/**
 * Opus의 V5 할당량 게이지 — 100%에서 시작해 생성할수록 줄어든다.
 * compact: 화면 맨 위의 얇은 줄, 아니면 설정 화면용 큰 표시.
 */
export function V5Gauge(props: { compact?: boolean }): ReactNode {
  const usage = useSettings((s) => s.subscription?.usage)
  const refresh = useSettings((s) => s.refreshSubscription)
  const fetchedAt = useSettings((s) => s.subscriptionAt)
  // 남은 시간이 흐르도록 1분마다 다시 그린다
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60000)
    return () => clearInterval(t)
  }, [])
  if (!usage) return null
  const percent = usagePercent(usage)
  const boost = boostPercent(usage)
  const depleted = percent + boost <= 0
  const t = tone(percent)
  const shown = `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
  const full = fullAt(usage, fetchedAt)
  const left = full === null ? null : formatDuration(full - Date.now())
  const bar = (
    <div
      role="progressbar"
      aria-label="V5 할당량"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(percent))}
      aria-valuetext={shown}
      className={cx('min-w-10 flex-1 overflow-hidden rounded-full bg-raised', props.compact ? 'h-1.5' : 'h-2.5')}
    >
      <div className={cx('h-full rounded-full transition-[width] duration-500', t.bar)} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  )

  if (props.compact) {
    return (
      <button
        type="button"
        title="V5 할당량 — 눌러서 새로고침"
        onClick={() => void refresh()}
        className="flex h-6 w-full shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[11px]"
      >
        <span className="shrink-0 text-dim">V5 할당량</span>
        {bar}
        <span className={cx('shrink-0 font-mono tabular-nums', depleted ? 'text-danger' : t.text)}>
          {depleted ? '소진' : shown}
        </span>
        {boost > 0 && <span className="shrink-0 font-mono tabular-nums text-dim">+부스트 {Math.round(boost)}%</span>}
        {left !== null && <span className="shrink-0 text-dim">· 가득까지 {left}</span>}
      </button>
    )
  }

  const perDay = refillPerDay(usage)
  return (
    <div className="pb-2">
      <div className="flex items-baseline justify-between text-sm">
        <span>V5 할당량</span>
        <span className={cx('font-mono text-base tabular-nums', depleted ? 'text-danger' : t.text)}>{shown}</span>
      </div>
      <div className="mt-1.5 flex">{bar}</div>
      <p className="mt-1.5 text-xs text-dim">
        {depleted ? '할당량을 다 썼습니다. V5 생성은 Anlas로 차감됩니다. ' : ''}
        {percent >= 100
          ? '가득 찬 상태라 충전이 멈춰 있습니다.'
          : perDay > 0
            ? `하루에 약 ${perDay}%씩 다시 찹니다.`
            : '충전이 멈춰 있습니다.'}
        {boost > 0 ? ` 부스트로 산 추가 할당량 ${Math.round(boost)}%가 남아 있습니다.` : ''}
      </p>
      {full !== null && left !== null && (
        <p className="mt-1 text-xs" role="status">
          <span className="text-fg">100%까지 {left}</span>
          <span className="text-dim"> — {formatDate(full)}쯤 가득 찹니다 (그 사이에 쓰지 않을 때)</span>
        </p>
      )}
      <p className="mt-1 text-[11px] text-dim">
        정해진 시각에 한꺼번에 초기화되는 것이 아니라 조금씩 계속 차오르는 방식입니다.
      </p>
    </div>
  )
}
