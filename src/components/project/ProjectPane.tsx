/**
 * "프로젝트" 화면 — 에셋 제작 프로젝트 목록과, 연 프로젝트(행렬 · 설정 · 내보내기).
 * 프로젝트 상태는 src/project/store.ts(localStorage 'naip-projects')에 있다.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, FolderKanban, Pencil, Plus, Square, Trash2 } from 'lucide-react'
import { useBackClose } from '../../lib/back'
import { cx } from '../../lib/util'
import { describeAction, expandMatrix, matrixTotals, projectGuide, useProjects, type Project } from '../../project'
import { useGeneration } from '../../stores/generation'
import { usePrompt } from '../../stores/prompt'
import { Button, Empty, IconButton, Sheet, TextInput } from '../ui'
import { formatDate, ProgressBar, Segmented } from './common'
import { GuideIntro } from './Guide'
import { MatrixView } from './MatrixView'
import { ProjectEditor } from './ProjectEditor'
import { ExportView } from './ExportView'

/** 저장된 프로젝트 상태가 이보다 크면 경고 (localStorage는 기기마다 5MB 안팎) */
export const PROJECTS_SIZE_WARN = 3 * 1024 * 1024

function storedSize(): number {
  try {
    return localStorage.getItem('naip-projects')?.length ?? 0
  } catch {
    return 0
  }
}

export function ProjectPane(): ReactNode {
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeId) ?? null)
  return project ? <ProjectView key={project.id} project={project} /> : <ProjectList />
}

function NameSheet(props: { title: string; initial: string; hint?: string; action: string; onSave: (name: string) => void; onClose: () => void }): ReactNode {
  const [name, setName] = useState(props.initial)
  return (
    <Sheet
      title={props.title}
      onClose={props.onClose}
      footer={
        <Button
          variant="primary"
          className="flex-1"
          disabled={!name.trim()}
          onClick={() => {
            props.onSave(name.trim())
            props.onClose()
          }}
        >
          {props.action}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <TextInput label="프로젝트 이름" value={name} onChange={setName} placeholder="예: 봄 이벤트 표정 세트" />
        {props.hint && <p className="text-xs text-dim">{props.hint}</p>}
      </div>
    </Sheet>
  )
}

function ProjectCard(props: { project: Project; onRename: () => void }): ReactNode {
  const p = props.project
  const s = useProjects.getState()
  const { totals, guide } = useMemo(() => {
    const m = expandMatrix(p)
    return { totals: m.tooMany ? null : matrixTotals(p, m), guide: projectGuide(p, m) }
  }, [p])
  const next = guide.actions[0]
  const images = Object.values(p.items).reduce((n, i) => n + i.images.length, 0)
  return (
    <li className="rounded-xl border border-line bg-panel">
      <button type="button" onClick={() => s.setActive(p.id)} className="block w-full px-3 pb-2 pt-3 text-left" aria-label={`${p.name} 열기`}>
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{p.name}</span>
          <span className="shrink-0 text-[11px] text-dim">{formatDate(p.updatedAt)}</span>
        </div>
        {totals ? (
          <>
            <div className="mt-1 text-xs text-dim">
              조합 {totals.combos}개 · 채택 {totals.adopted}/{totals.target} · 그림 {images}장
            </div>
            <ProgressBar className="mt-2" value={totals.progress} label={`${p.name} 진행률`} />
          </>
        ) : (
          <div className="mt-1 text-xs text-danger">조합이 너무 많아 진행을 셀 수 없습니다</div>
        )}
        <div className={cx('mt-2 flex items-center gap-1 text-xs', next.kind === 'done' ? 'text-ok' : 'text-accent')}>
          <span className="min-w-0 flex-1 truncate">
            {next.kind === 'done' ? '' : '다음: '}
            {describeAction(next)}
          </span>
          <ChevronRight size={14} className="shrink-0" />
        </div>
      </button>
      <div className="flex justify-end gap-0.5 border-t border-line px-1 py-0.5">
        <IconButton label={`${p.name} 이름 바꾸기`} onClick={props.onRename}>
          <Pencil size={16} />
        </IconButton>
        <IconButton label={`${p.name} 복제`} onClick={() => s.duplicate(p.id)}>
          <Copy size={16} />
        </IconButton>
        <IconButton
          label={`${p.name} 삭제`}
          onClick={() => {
            // 대기·생성 중인 장이 있으면 함께 취소할지 묻는다 — 그대로 두면 지운 프로젝트의 그림이 계속 생성(과금)된다
            const busy = Object.values(p.items).reduce((n, i) => n + i.queued + i.generating, 0)
            const note = busy ? `\n이 프로젝트의 그림 ${busy}장이 아직 대기·생성 중입니다.` : ''
            if (!window.confirm(`"${p.name}" 프로젝트를 삭제할까요?\n설정·선별 기록만 지워지고, 만든 그림은 히스토리에 그대로 남습니다.${note}`)) return
            if (busy && window.confirm(`대기·생성 중인 ${busy}장도 취소할까요?\n취소하지 않으면 계속 생성(과금)되어 히스토리에만 남습니다.`)) {
              useGeneration.getState().cancelProject(p.id)
            }
            s.remove(p.id)
          }}
        >
          <Trash2 size={16} className="text-danger" />
        </IconButton>
      </div>
    </li>
  )
}

function ProjectList(): ReactNode {
  const projects = useProjects((s) => s.projects)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const size = useMemo(storedSize, [projects])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="flex-1 text-sm font-semibold">
          에셋 프로젝트 <span className="ml-1 font-mono text-xs font-normal text-dim">{projects.length}</span>
        </span>
        <Button variant="primary" className="px-3" onClick={() => setCreating(true)}>
          <Plus size={16} />새 프로젝트
        </Button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        {size > PROJECTS_SIZE_WARN && (
          <p role="alert" className="mb-3 flex gap-2 rounded-lg bg-danger/15 px-3 py-2 text-xs text-danger">
            <AlertTriangle size={16} className="shrink-0" />
            프로젝트 기록이 {(size / 1024 / 1024).toFixed(1)}MB로 커졌습니다. 브라우저 저장 한도(약 5MB)에 가까워지면 저장이 실패할 수 있으니,
            끝난 프로젝트를 지우거나 복제본을 정리해 주세요.
          </p>
        )}
        {projects.length === 0 ? (
          <Empty>
            <FolderKanban size={28} className="mx-auto mb-2 text-dim" />
            캐릭터 × 표정 × 의상처럼 조합마다 그림을 만들어 고르고, 정해 둔 이름으로 내보내는 작업 단위입니다.
            <GuideIntro />
            <Button variant="primary" className="mx-auto mt-4" onClick={() => setCreating(true)}>
              <Plus size={16} />새 프로젝트 만들기
            </Button>
          </Empty>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-2">
            {[...projects]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((p) => (
                <ProjectCard key={p.id} project={p} onRename={() => setRenaming(p)} />
              ))}
          </ul>
        )}
      </div>
      {creating && (
        <NameSheet
          title="새 프로젝트"
          initial=""
          action="만들기"
          hint="지금 프롬프트 화면의 모델·해상도·샘플링 설정으로 시작합니다 (나중에 바꿀 수 있습니다). 만든 뒤 캐릭터와 축(표정·의상 …)을 넣습니다."
          onSave={(name) => useProjects.getState().create(name, { ...usePrompt.getState().params })}
          onClose={() => setCreating(false)}
        />
      )}
      {renaming && (
        <NameSheet
          title="이름 바꾸기"
          initial={renaming.name}
          action="저장"
          onSave={(name) => useProjects.getState().patch(renaming.id, { name })}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  )
}

type View = 'matrix' | 'edit' | 'export'

/** 화면 순서 = 작업 순서 (설정 → 행렬에서 생성·선별 → 내보내기) */
const VIEWS: { value: View; label: string }[] = [
  { value: 'edit', label: '설정' },
  { value: 'matrix', label: '행렬' },
  { value: 'export', label: '내보내기' }
]

/** 생성 중일 때 어느 화면에서나 보이는 한 줄 (중지 포함) */
export function RunStrip(): ReactNode {
  const g = useGeneration()
  if (!g.running && !g.error) return null
  const settled = g.done + g.failed
  const queued = g.queue.reduce((n, b) => n + b.count, 0)
  return (
    <div className="shrink-0 border-t border-line bg-panel px-3 py-1.5">
      {g.error && !g.running && <p className="line-clamp-2 text-xs text-danger">{g.error}</p>}
      {g.running && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs">
              {g.currentLabel} · {Math.min(settled + 1, g.total)}/{g.total}
              {queued ? ` · 대기 ${queued}장` : ''}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${g.total ? (settled / g.total) * 100 : 0}%` }} />
            </div>
          </div>
          <Button
            variant="default"
            className="px-3"
            onClick={() => {
              if (g.queue.length && !window.confirm(`지금 배치를 멈추고 대기 중인 ${g.queue.length}개도 취소할까요?`)) return
              g.stop()
            }}
          >
            <Square size={13} className="fill-current" />
            중지
          </Button>
        </div>
      )}
    </div>
  )
}

function ProjectView(props: { project: Project }): ReactNode {
  const p = props.project
  const [view, setView] = useState<View>(() => (p.characters.length || p.axes.length ? 'matrix' : 'edit'))
  const close = (): void => useProjects.getState().setActive(null)
  useBackClose(close)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2">
        <IconButton label="프로젝트 목록" onClick={close}>
          <ChevronLeft size={20} />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{p.name}</h2>
      </div>
      <div className="shrink-0 border-b border-line px-3 py-2">
        <Segmented
          label="프로젝트 화면"
          value={view}
          onChange={setView}
          options={VIEWS}
          className="mx-auto max-w-3xl"
        />
      </div>
      <div className={cx('flex min-h-0 flex-1 flex-col')}>
        {view === 'matrix' && <MatrixView project={p} onEdit={() => setView('edit')} onExport={() => setView('export')} />}
        {view === 'edit' && <ProjectEditor project={p} onMatrix={() => setView('matrix')} />}
        {view === 'export' && <ExportView project={p} />}
      </div>
      <RunStrip />
    </div>
  )
}
