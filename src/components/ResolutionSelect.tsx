import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { findResolution, resolutionGroups, sizeKey, sizeProblem, sizeText, type ResolutionPrefs } from '../nai/resolutionList'
import { cx } from '../lib/util'
import { useSettings } from '../stores/settings'
import { ResolutionListSheet } from './ResolutionListSheet'

export const CUSTOM = 'custom'
const NONE = 'none'
const ADD = 'add-to-list'
const EDIT = 'edit-list'

/** 지금 해상도 목록 설정 (화면 밖에서 한 번 읽을 때) */
export function resolutionPrefs(): ResolutionPrefs {
  const s = useSettings.getState()
  return { resolutions: s.resolutions, hiddenResolutions: s.hiddenResolutions }
}

/**
 * 해상도 선택 — 숨기지 않은 NAI 기본 해상도 + "내 해상도", 맨 아래 "목록 편집…".
 * 목록에 없는 크기(예전 프리셋·이미지에서 온 것, 숨긴 기본 해상도)는 바꾸지 않고 "사용자 지정 (W×H)"로 보이며,
 * 그 크기를 "목록에 추가…"할 수 있다
 */
export function ResolutionSelect(props: {
  width: number
  height: number
  /** 사용자 지정 입력을 펼친 상태 — 목록의 크기와 같아도 "사용자 지정"으로 보인다 */
  custom?: boolean
  onPick: (size: { width: number; height: number }) => void
  /** 주면 "사용자 지정" 항목을 고를 수 있다 */
  onCustom?: () => void
  /** 주면 맨 위에 크기를 정하지 않는 항목("메인 설정을 따름" 등)을 둔다. selected 면 그 항목이 골라져 있다 */
  none?: { label: string; selected: boolean; onPick: () => void }
  /** 칸 이름 (기본 "해상도") */
  label?: string
  className?: string
}): ReactNode {
  const resolutions = useSettings((s) => s.resolutions)
  const hiddenResolutions = useSettings((s) => s.hiddenResolutions)
  const groups = useMemo(() => resolutionGroups({ resolutions, hiddenResolutions }), [resolutions, hiddenResolutions])
  const [editing, setEditing] = useState<null | { prefill?: { width: number; height: number } }>(null)
  const noneSelected = !!props.none?.selected
  const found = noneSelected ? undefined : findResolution(groups, props.width, props.height)
  const isCustom = !noneSelected && (!!props.custom || !found)
  // 목록에 없는, 쓸 수 있는 크기면 목록에 더할 수 있다
  const canAdd = !noneSelected && !found && !sizeProblem(props.width, props.height)
  const value = noneSelected ? NONE : isCustom ? CUSTOM : found!.key
  return (
    <div className={cx('relative', props.className)}>
      <select
        aria-label={props.label ?? '해상도'}
        value={value}
        onChange={(e) => {
          const v = e.target.value
          if (v === NONE) return props.none?.onPick()
          if (v === CUSTOM) return props.onCustom?.()
          if (v === EDIT) return setEditing({})
          if (v === ADD) return setEditing({ prefill: { width: props.width, height: props.height } })
          const r = groups.flatMap((g) => g.items).find((o) => o.key === v)
          if (r) props.onPick({ width: r.width, height: r.height })
        }}
        className="h-11 w-full appearance-none truncate rounded-lg border border-line bg-field pl-3 pr-8 text-sm text-fg"
      >
        {props.none && <option value={NONE}>{props.none.label}</option>}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((o) => (
              <option key={o.key} value={o.key}>
                {o.text}
              </option>
            ))}
          </optgroup>
        ))}
        {(props.onCustom || isCustom) && (
          <optgroup label="Custom">
            <option value={CUSTOM}>사용자 지정{isCustom ? ` (${sizeText(props.width, props.height)})` : ''}</option>
          </optgroup>
        )}
        <optgroup label="목록">
          {canAdd && <option value={ADD}>{sizeText(props.width, props.height)} 목록에 추가…</option>}
          <option value={EDIT}>목록 편집…</option>
        </optgroup>
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-dim" />
      {editing && (
        <ResolutionListSheet
          prefill={editing.prefill}
          onClose={() => setEditing(null)}
          onAdded={(size) => {
            // 지금 크기를 목록에 더했으면 "사용자 지정" 대신 목록 항목으로 보이게
            if (!noneSelected && sizeKey(size.width, size.height) === sizeKey(props.width, props.height)) props.onPick(size)
            // "목록에 추가…"로 열었으면 더한 뒤 닫는다
            if (editing.prefill) setEditing(null)
          }}
        />
      )}
    </div>
  )
}
