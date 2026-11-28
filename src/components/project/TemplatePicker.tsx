/** 축 편집의 "여러 줄 추가" 칸에 빠른 시작 세트를 불러오는 칩 */
import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { AXIS_TEMPLATES, appendTemplateLines, missingTemplateValues, parseValueLines, type Axis } from '../../project'

/**
 * 축 편집의 "여러 줄 추가" 칸에 세트를 불러오는 칩 — 축에도 칸에도 없는 값만 줄로 덧붙여 고친 뒤 추가할 수 있게
 * (두 번 눌러도 같은 줄이 다시 들어가지 않는다)
 */
export function TemplateLinesPicker(props: { axis: Pick<Axis, 'kind' | 'values'>; text: string; onChange: (text: string) => void }): ReactNode {
  const list = AXIS_TEMPLATES.filter((t) => t.kind === props.axis.kind)
  if (!list.length) return null
  const written = parseValueLines(props.text)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-dim">세트 불러오기</span>
      {list.map((t) => {
        const inAxis = missingTemplateValues(props.axis, t).length
        const left = missingTemplateValues({ values: [...props.axis.values, ...written] }, t).length
        return (
          <button
            key={t.id}
            type="button"
            disabled={!left}
            onClick={() => props.onChange(appendTemplateLines(props.text, props.axis, t))}
            className="flex h-8 items-center gap-1 rounded-full border border-line px-2.5 text-[11px] text-fg active:bg-raised"
          >
            <Sparkles size={12} className="text-accent" />
            {t.title}
            <span className="text-dim">{left ? `+${left}` : inAxis ? '칸에 넣음' : '모두 있음'}</span>
          </button>
        )
      })}
    </div>
  )
}
