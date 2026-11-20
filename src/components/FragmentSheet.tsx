import { useState, type ReactNode } from 'react'
import { Dices, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { processWildcards } from '../nai/fragments'
import { cx } from '../lib/util'
import { fragmentPath, fragmentSource, useFragments, type Fragment } from '../stores/fragments'
import { mergePromptParts, usePrompt } from '../stores/prompt'
import { Button, Empty, IconButton, Select, Sheet, TextArea, TextInput } from './ui'

type Target = 'base' | 'additional' | 'detail' | 'negative'
const TARGETS: { value: Target; label: string }[] = [
  { value: 'additional', label: '가변에 삽입' },
  { value: 'base', label: '고정에 삽입' },
  { value: 'detail', label: '디테일에 삽입' },
  { value: 'negative', label: '네거티브에 삽입' }
]

function FragmentEditor(props: { initial: Partial<Fragment>; onClose: () => void }): ReactNode {
  const { folders, saveFragment, deleteFragment } = useFragments()
  const [name, setName] = useState(props.initial.name ?? '')
  const [folderId, setFolderId] = useState<number | null>(props.initial.folderId ?? null)
  const [content, setContent] = useState(props.initial.content ?? '')
  const id = props.initial.id
  const lines = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
  return (
    <Sheet
      title={id ? '조각 편집' : '조각 추가'}
      onClose={props.onClose}
      footer={
        <>
          {id !== undefined && (
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm(`"${name}" 조각을 삭제할까요?`)) {
                  deleteFragment(id)
                  props.onClose()
                }
              }}
            >
              <Trash2 size={16} />
              삭제
            </Button>
          )}
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => {
              saveFragment({ id, name: name.replace(/[<>|/]/g, ' '), folderId, content })
              props.onClose()
            }}
          >
            저장
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-dim">
          이름 — 프롬프트에서 {'<이름>'} 으로 부릅니다
          <TextInput label="이름" value={name} onChange={setName} placeholder="예: 머리색" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          폴더
          <Select
            label="폴더"
            value={folderId ?? 0}
            options={[{ value: 0, label: '없음' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(v) => setFolderId(v === 0 ? null : v)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          선택지 — 한 줄에 하나 ({lines}개). #으로 시작하는 줄은 무시합니다
          <TextArea
            label="선택지"
            rows={10}
            value={content}
            onChange={setContent}
            placeholder={'black hair\nblonde hair\nbrown hair'}
          />
        </label>
      </div>
    </Sheet>
  )
}

export function FragmentSheet(props: { onClose: () => void }): ReactNode {
  const s = useFragments()
  const p = usePrompt()
  const [filter, setFilter] = useState<'all' | null | number>('all')
  const [editing, setEditing] = useState<Partial<Fragment> | null>(null)
  const [target, setTarget] = useState<Target>('additional')
  const [preview, setPreview] = useState<string | null>(null)
  const [inserted, setInserted] = useState<string | null>(null)

  const shown = s.fragments.filter((f) => filter === 'all' || f.folderId === filter)
  const folder = typeof filter === 'number' ? s.folders.find((f) => f.id === filter) : undefined
  const chip = (active: boolean): string =>
    cx(
      'h-9 shrink-0 rounded-full border px-3 text-[13px]',
      active ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
    )
  const insert = (f: Fragment): void => {
    const tag = `<${fragmentPath(f, s.folders)}>`
    const cur = p[target].trim().replace(/,\s*$/, '')
    p.set({ [target]: cur ? `${cur}, ${tag}` : tag })
    setInserted(tag)
  }

  return (
    <>
      <Sheet
        title="조각 (와일드카드)"
        onClose={props.onClose}
        footer={
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => setEditing({ folderId: typeof filter === 'number' ? filter : null })}
          >
            <Plus size={16} />
            조각 추가
          </Button>
        }
      >
        <details className="mb-3 rounded-lg border border-line bg-field px-3 py-2 text-xs text-dim">
          <summary className="cursor-pointer py-1 text-fg">문법 보기</summary>
          <ul className="mt-1 flex flex-col gap-1 font-mono leading-relaxed">
            <li>{'<이름>'} · {'<폴더/이름>'} — 조각에서 무작위 한 줄</li>
            <li>{'<*이름>'} — 장마다 순서대로 한 줄씩</li>
            <li>{'<a|b|c>'} — 그 자리에서 무작위</li>
            <li>(a, b/c, d) — 슬래시로 나눈 묶음 중 하나</li>
            <li>red/blue/green — 태그 안 슬래시 중 하나</li>
          </ul>
          <p className="mt-1">장마다 새로 뽑으며, 캐릭터·씬 프롬프트와 네거티브에도 적용됩니다.</p>
        </details>

        <div className="mb-3 rounded-lg border border-line bg-field p-2.5">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-dim">지금 프롬프트로 뽑아 보기</span>
            <Button
              className="!h-9"
              onClick={() => setPreview(processWildcards(mergePromptParts(p), fragmentSource(), Math.random, true))}
            >
              <Dices size={15} />
              굴리기
            </Button>
          </div>
          {preview !== null && (
            <p className="mt-2 select-text whitespace-pre-wrap break-words font-mono text-xs">
              {preview || '(빈 프롬프트)'}
            </p>
          )}
        </div>

        <div className="mb-2 flex items-center gap-2">
          <Select label="삽입 위치" className="w-44" value={target} options={TARGETS} onChange={setTarget} />
          {inserted && <span className="min-w-0 flex-1 truncate font-mono text-xs text-accent">{inserted} 삽입됨</span>}
        </div>

        <div className="scroll-thin -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-2">
          <button type="button" className={chip(filter === 'all')} onClick={() => setFilter('all')}>
            전체 {s.fragments.length}
          </button>
          {s.folders.map((f) => (
            <button key={f.id} type="button" className={chip(filter === f.id)} onClick={() => setFilter(f.id)}>
              {f.name} {s.fragments.filter((x) => x.folderId === f.id).length}
            </button>
          ))}
          <button
            type="button"
            className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-3 text-[13px] text-dim"
            onClick={() => {
              const name = window.prompt('새 폴더 이름', '')
              if (name !== null) setFilter(s.addFolder(name.replace(/[<>|/]/g, ' ')))
            }}
          >
            <FolderPlus size={15} />
            폴더
          </button>
        </div>
        {folder && (
          <div className="mb-2 flex items-center gap-1 text-xs text-dim">
            <span className="min-w-0 flex-1 truncate">폴더: {folder.name}</span>
            <button
              type="button"
              className="h-8 rounded-md px-2 active:bg-raised"
              onClick={() => {
                const name = window.prompt('폴더 이름', folder.name)
                if (name !== null) s.renameFolder(folder.id, name.replace(/[<>|/]/g, ' '))
              }}
            >
              이름 바꾸기
            </button>
            <button
              type="button"
              className="h-8 rounded-md px-2 text-danger active:bg-raised"
              onClick={() => {
                if (!window.confirm(`"${folder.name}" 폴더를 삭제할까요? 안의 조각은 폴더 없음으로 옮깁니다.`)) return
                s.deleteFolder(folder.id)
                setFilter('all')
              }}
            >
              폴더 삭제
            </button>
          </div>
        )}
        {shown.length === 0 ? (
          <Empty>조각이 없습니다. 무작위로 바꿔 넣을 태그 묶음을 만들어 보세요.</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shown.map((f) => (
              <li key={f.id} className="flex items-center rounded-lg border border-line bg-field">
                <button type="button" className="min-w-0 flex-1 px-3 py-2.5 text-left" onClick={() => insert(f)}>
                  <span className="block truncate font-mono text-[13px]">{`<${fragmentPath(f, s.folders)}>`}</span>
                  <span className="block truncate text-xs text-dim">
                    {f.content.split('\n').filter((l) => l.trim()).slice(0, 4).join(' · ') || '(비어 있음)'}
                  </span>
                </button>
                <IconButton label={`${f.name} 편집`} onClick={() => setEditing(f)}>
                  <Pencil size={17} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
      {editing && <FragmentEditor initial={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
