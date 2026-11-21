import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { RESOLUTIONS } from '../nai/constants'
import { cx } from '../lib/util'

/** NovelAI 웹의 해상도 목록과 같은 묶음 */
const GROUPS: { label: string; items: number[] }[] = [
  { label: 'Normal', items: [0, 1, 2] },
  { label: 'Large', items: [3, 4, 5] },
  { label: 'Wallpaper', items: [6, 7] },
  { label: 'Small', items: [8, 9, 10] }
]

export const CUSTOM = 'custom'

/** NAI 기본 해상도 선택. 목록에 없는 크기는 "사용자 지정"으로 표시한다 */
export function ResolutionSelect(props: {
  width: number
  height: number
  /** 사용자 지정 입력을 펼친 상태 — 목록의 크기와 같아도 "사용자 지정"으로 보인다 */
  custom?: boolean
  onPick: (size: { width: number; height: number }) => void
  /** 주면 "사용자 지정" 항목을 고를 수 있다 */
  onCustom?: () => void
  className?: string
}): ReactNode {
  const index = RESOLUTIONS.findIndex((r) => r.width === props.width && r.height === props.height)
  const isCustom = props.custom || index < 0
  return (
    <div className={cx('relative', props.className)}>
      <select
        aria-label="해상도"
        value={isCustom ? CUSTOM : String(index)}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return props.onCustom?.()
          const r = RESOLUTIONS[Number(e.target.value)]
          props.onPick({ width: r.width, height: r.height })
        }}
        className="h-11 w-full appearance-none truncate rounded-lg border border-line bg-field pl-3 pr-8 text-sm text-fg"
      >
        {GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((i) => (
              <option key={i} value={i}>
                {RESOLUTIONS[i].label} ({RESOLUTIONS[i].width}×{RESOLUTIONS[i].height})
              </option>
            ))}
          </optgroup>
        ))}
        {(props.onCustom || isCustom) && (
          <optgroup label="Custom">
            <option value={CUSTOM}>
              사용자 지정{isCustom ? ` (${props.width}×${props.height})` : ''}
            </option>
          </optgroup>
        )}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-dim" />
    </div>
  )
}
