/**
 * 축 추가 — 빠른 시작 세트(표정 기본 세트 등)나 빈 축. 세트는 같은 종류의 축이 있으면 그 축에 빠진 값만 더하고
 * (있던 값은 그대로), 없으면 새 축으로 만든다. 넣은 뒤에는 축 편집 시트가 열려 바로 고칠 수 있다.
 */
import type { ReactNode } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import {
  AXIS_KIND_LABEL,
  AXIS_TEMPLATES,
  applyAxisTemplate,
  missingTemplateValues,
  templateTarget,
  useProjects,
  type AxisKind,
  type AxisTemplate,
  type Project
} from '../../project'
import { toast } from '../../stores/toast'
import { Button, Sheet } from '../ui'
import { confirmKeyChange } from './EditorSheets'

const EMPTY_KINDS: AxisKind[] = ['expression', 'outfit', 'situation', 'location', 'action', 'custom']

/** 세트를 넣고 넣은 축 id (취소했거나 더할 것이 없으면 null) */
export function insertTemplate(p: Project, t: AxisTemplate): string | null {
  const target = templateTarget(p, t)
  const adds = missingTemplateValues(target, t)
  if (!adds.length) {
    toast(`"${target?.name ?? t.axisName}" 축에 ${t.title}의 값이 이미 모두 있습니다`)
    return target?.id ?? null
  }
  const next = applyAxisTemplate(p, t).project
  if (!confirmKeyChange(p, next, `${t.title}을(를) 넣으면`, true)) return null
  const id = useProjects.getState().applyAxisTemplate(p.id, t.id)
  toast(target ? `"${target.name}" 축에 ${adds.length}개를 더했습니다 (있던 값은 그대로)` : `${t.title} ${adds.length}개를 넣었습니다 — 눌러서 고칠 수 있습니다`)
  return id
}

/** 세트 한 줄 설명 — 어디에 무엇이 들어가는지 */
function templateNote(p: Project, t: AxisTemplate): { text: string; full: boolean } {
  const target = templateTarget(p, t)
  if (!target) return { text: `새 "${t.axisName}" 축으로 ${t.values.length}개`, full: false }
  const n = missingTemplateValues(target, t).length
  return n ? { text: `"${target.name}" 축에 없는 ${n}개만 더함`, full: false } : { text: `"${target.name}" 축에 이미 모두 있음`, full: true }
}

export function AxisAddSheet(props: { project: Project; onAdded: (axisId: string) => void; onClose: () => void }): ReactNode {
  const p = props.project
  const done = (id: string | null): void => {
    if (!id) return
    props.onClose()
    props.onAdded(id)
  }
  return (
    <Sheet title="축 추가" onClose={props.onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-dim">
          축은 캐릭터와 곱할 항목입니다. 축의 값(예: 표정 축의 웃음·울음)마다 그림이 따로 만들어집니다. 캐릭터 2명 × 표정 6개 = 조합 12개.
        </p>
        <section>
          <h3 className="mb-1.5 flex items-center gap-1 text-xs font-semibold">
            <Sparkles size={14} className="text-accent" />
            빠른 시작 세트
          </h3>
          <ul className="flex flex-col gap-1.5">
            {AXIS_TEMPLATES.map((t) => {
              const note = templateNote(p, t)
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={note.full}
                    onClick={() => done(insertTemplate(p, t))}
                    className="flex w-full items-center gap-2 rounded-lg border border-line bg-field px-3 py-2.5 text-left active:bg-raised"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{t.title}</span>
                      <span className="block truncate text-[11px] text-dim">{t.values.map((v) => v.label).join(' · ')}</span>
                      <span className="block text-[11px] text-accent">{note.text}</span>
                    </span>
                    <Plus size={18} className="shrink-0 text-dim" />
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="mt-1.5 text-[11px] text-dim">넣은 뒤 값 이름·파일 이름·태그를 고치거나 지울 수 있습니다.</p>
        </section>
        <section>
          <h3 className="mb-1.5 text-xs font-semibold">빈 축</h3>
          <div className="grid grid-cols-3 gap-1.5">
            {EMPTY_KINDS.map((k) => (
              <Button
                key={k}
                variant="default"
                className="px-2"
                onClick={() => done(useProjects.getState().addAxis(p.id, k))}
              >
                {AXIS_KIND_LABEL[k]}
              </Button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-dim">종류에 따라 파일 이름 변수({'{emotion}'}·{'{outfit}'} …)와 태그를 넣을 곳이 정해집니다.</p>
        </section>
      </div>
    </Sheet>
  )
}

/** 축이 하나도 없을 때 설정 화면에 바로 보이는 세트 단추 */
export function AxisQuickStart(props: { project: Project; onAdded: (axisId: string) => void; onMore: () => void }): ReactNode {
  const p = props.project
  const quick = AXIS_TEMPLATES.filter((t) => t.id === 'expression-basic' || t.id === 'outfit-basic')
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        {quick.map((t) => (
          <Button
            key={t.id}
            variant="default"
            className="h-auto min-h-11 flex-col gap-0 px-2 py-1.5"
            onClick={() => {
              const id = insertTemplate(p, t)
              if (id) props.onAdded(id)
            }}
          >
            <span className="flex items-center gap-1">
              <Sparkles size={14} className="text-accent" />
              {t.title}
            </span>
            <span className="max-w-full truncate text-[11px] font-normal text-dim">{t.values.map((v) => v.label).join('·')}</span>
          </Button>
        ))}
      </div>
      <Button variant="ghost" className="text-xs" onClick={props.onMore}>
        <Plus size={14} />
        다른 세트 · 빈 축 만들기
      </Button>
    </div>
  )
}
