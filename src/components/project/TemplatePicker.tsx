/** 축 편집의 "여러 줄 추가" 칸에 빠른 시작 세트를 불러오는 칩 */
import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { AXIS_TEMPLATES, missingTemplateValues, templateLines, type Axis } from '../../project'

/** 축 편집의 "여러 줄 추가" 칸에 세트를 불러오는 칩 — 빠진 값만 줄로 넣어 고친 뒤 추가할 수 있게 */
export function TemplateLinesPicker(props: { axis: Pick<Axis, 'kind' | 'values'>; onPick: (lines: string) => void }): ReactNode {
  const list = AXIS_TEMPLATES.filter((t) => t.kind === props.axis.kind)
  if (!list.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-dim">세트 불러오기</span>
      {list.map((t) => {
        const missing = missingTemplateValues(props.axis, t)
        return (
          <button
            key={t.id}
            type="button"
            disabled={!missing.length}
            onClick={() => props.onPick(templateLines(missing))}
            className="flex h-8 items-center gap-1 rounded-full border border-line px-2.5 text-[11px] text-fg active:bg-raised"
          >
            <Sparkles size={12} className="text-accent" />
            {t.title}
            <span className="text-dim">{missing.length ? `+${missing.length}` : '모두 있음'}</span>
          </button>
        )
      })}
    </div>
  )
}
