import { useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  FolderPlus,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { modelCapabilities } from '../nai/models'
import { cx } from '../lib/util'
import { useCharacters, type Character } from '../stores/characters'
import { usePrompt } from '../stores/prompt'
import { Button, Empty, IconButton, Select, Sheet, TextArea, TextInput, Toggle } from './ui'

/** 폴더 필터: 'all' = 전체, null = 미분류, number = 폴더 id */
type FolderFilter = 'all' | null | number

const GRID = [0.1, 0.3, 0.5, 0.7, 0.9]

function PositionGrid(props: {
  value: { x: number; y: number } | null
  onChange: (v: { x: number; y: number } | null) => void
}): ReactNode {
  return (
    <div className="flex items-start gap-3 px-3 pb-3">
      <div className="grid w-40 grid-cols-5 gap-1" role="group" aria-label="캐릭터 위치">
        {GRID.map((y) =>
          GRID.map((x) => {
            const on = props.value?.x === x && props.value?.y === y
            return (
              <button
                key={`${x}-${y}`}
                type="button"
                aria-label={`가로 ${x}, 세로 ${y}`}
                aria-pressed={on}
                onClick={() => props.onChange({ x, y })}
                className={cx('aspect-square rounded', on ? 'bg-accent' : 'bg-raised')}
              />
            )
          })
        )}
      </div>
      <div className="flex-1 text-xs text-dim">
        <p>이미지 안에서 캐릭터가 설 위치입니다. 활성 캐릭터가 2명 이상일 때만 적용됩니다.</p>
        <button
          type="button"
          onClick={() => props.onChange(null)}
          className={cx(
            'mt-2 h-9 rounded-lg px-3 text-sm',
            props.value === null ? 'bg-accent text-accent-fg' : 'bg-raised text-fg'
          )}
        >
          AI 선택
        </button>
      </div>
    </div>
  )
}

function CharacterEditor(props: {
  initial: Partial<Character>
  onClose: () => void
}): ReactNode {
  const { folders, saveCharacter, deleteCharacter } = useCharacters()
  const [name, setName] = useState(props.initial.name ?? '')
  const [folderId, setFolderId] = useState<number | null>(props.initial.folderId ?? null)
  const [prompt, setPrompt] = useState(props.initial.prompt ?? '')
  const [negative, setNegative] = useState(props.initial.negative ?? '')
  const id = props.initial.id

  return (
    <Sheet
      title={id ? '캐릭터 편집' : '캐릭터 추가'}
      onClose={props.onClose}
      footer={
        <>
          {id !== undefined && (
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm(`"${name}" 캐릭터를 삭제할까요?`)) {
                  deleteCharacter(id)
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
              saveCharacter({ id, name, folderId, prompt, negative })
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
          이름
          <TextInput label="이름" value={name} onChange={setName} placeholder="캐릭터 이름" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          폴더
          <Select
            label="폴더"
            value={folderId ?? 0}
            options={[{ value: 0, label: '미분류' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(v) => setFolderId(v === 0 ? null : v)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          캐릭터 프롬프트
          <TextArea
            label="캐릭터 프롬프트"
            rows={6}
            value={prompt}
            onChange={setPrompt}
            placeholder="1boy, black hair, ..."
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          캐릭터 네거티브 (선택)
          <TextArea label="캐릭터 네거티브" rows={3} value={negative} onChange={setNegative} />
        </label>
      </div>
    </Sheet>
  )
}

export function CharacterSheet(props: { onClose: () => void }): ReactNode {
  const s = useCharacters()
  const model = usePrompt((p) => p.params.model)
  const max = modelCapabilities(model).maxCharacters
  const [filter, setFilter] = useState<FolderFilter>('all')
  const [editing, setEditing] = useState<Partial<Character> | null>(null)
  const [posOpen, setPosOpen] = useState<number | null>(null)

  const inCast = new Set(s.cast.map((e) => e.charId))
  const enabledCount = s.cast.filter((e) => e.enabled).length
  const shown = s.characters.filter((c) => filter === 'all' || c.folderId === filter)
  const folder = typeof filter === 'number' ? s.folders.find((f) => f.id === filter) : undefined
  const chip = (active: boolean): string =>
    cx(
      'h-9 shrink-0 rounded-full border px-3 text-[13px]',
      active ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
    )

  return (
    <>
      <Sheet
        title="캐릭터"
        onClose={props.onClose}
        footer={
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => setEditing({ folderId: typeof filter === 'number' ? filter : null })}
          >
            <Plus size={16} />
            캐릭터 추가
          </Button>
        }
      >
        <div className="mb-1 flex items-center">
          <h3 className="text-xs text-dim">
            출연{' '}
            <span className={cx('font-mono', enabledCount > max && 'text-danger')}>
              {enabledCount}/{max}
            </span>
          </h3>
          {s.cast.length > 0 && (
            <button type="button" className="ml-auto h-8 px-2 text-xs text-dim" onClick={s.clearCast}>
              모두 내리기
            </button>
          )}
        </div>
        {s.cast.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-dim">
            아래 라이브러리에서 캐릭터를 눌러 출연시키세요
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {s.cast.map((e, i) => {
              const c = s.characters.find((x) => x.id === e.charId)
              if (!c) return null
              return (
                <li key={e.charId} className="rounded-lg border border-line bg-field">
                  <div className="flex items-center gap-1 py-1 pl-3 pr-1">
                    <Toggle
                      label={`${c.name} 사용`}
                      checked={e.enabled}
                      onChange={(enabled) => s.patchCast(e.charId, { enabled })}
                    />
                    <span className={cx('ml-2 min-w-0 flex-1 truncate', !e.enabled && 'text-dim')}>
                      {c.name}
                    </span>
                    <IconButton
                      label="위치"
                      active={posOpen === e.charId || e.center !== null}
                      onClick={() => setPosOpen(posOpen === e.charId ? null : e.charId)}
                    >
                      <MapPin size={17} />
                    </IconButton>
                    <IconButton label="위로" disabled={i === 0} onClick={() => s.moveCast(e.charId, -1)}>
                      <ArrowUp size={17} />
                    </IconButton>
                    <IconButton
                      label="아래로"
                      disabled={i === s.cast.length - 1}
                      onClick={() => s.moveCast(e.charId, 1)}
                    >
                      <ArrowDown size={17} />
                    </IconButton>
                    <IconButton label="출연에서 내리기" onClick={() => s.toggleCast(e.charId)}>
                      <X size={17} />
                    </IconButton>
                  </div>
                  {posOpen === e.charId && (
                    <PositionGrid
                      value={e.center}
                      onChange={(center) => s.patchCast(e.charId, { center })}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <h3 className="mb-1 mt-5 text-xs text-dim">라이브러리</h3>
        <div className="scroll-thin -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-2">
          <button type="button" className={chip(filter === 'all')} onClick={() => setFilter('all')}>
            전체 {s.characters.length}
          </button>
          <button type="button" className={chip(filter === null)} onClick={() => setFilter(null)}>
            미분류 {s.characters.filter((c) => c.folderId === null).length}
          </button>
          {s.folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className={chip(filter === f.id)}
              onClick={() => setFilter(f.id)}
            >
              {f.name} {s.characters.filter((c) => c.folderId === f.id).length}
            </button>
          ))}
          <button
            type="button"
            className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-3 text-[13px] text-dim"
            onClick={() => {
              const name = window.prompt('새 폴더 이름', '')
              if (name !== null) setFilter(s.addFolder(name))
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
                if (name !== null) s.renameFolder(folder.id, name)
              }}
            >
              이름 바꾸기
            </button>
            <button
              type="button"
              className="h-8 rounded-md px-2 text-danger active:bg-raised"
              onClick={() => {
                const n = s.characters.filter((c) => c.folderId === folder.id).length
                if (!window.confirm(`"${folder.name}" 폴더를 삭제할까요?`)) return
                const withChars =
                  n > 0 &&
                  window.confirm(
                    `폴더 안의 캐릭터 ${n}명도 함께 삭제할까요?\n취소를 누르면 캐릭터는 미분류로 옮깁니다.`
                  )
                s.deleteFolder(folder.id, withChars)
                setFilter('all')
              }}
            >
              폴더 삭제
            </button>
          </div>
        )}
        {shown.length === 0 ? (
          <Empty>이 폴더에 캐릭터가 없습니다</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shown.map((c) => {
              const on = inCast.has(c.id)
              return (
                <li
                  key={c.id}
                  className={cx(
                    'flex items-center rounded-lg border bg-field',
                    on ? 'border-accent' : 'border-line'
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={on}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
                    onClick={() => s.toggleCast(c.id)}
                  >
                    <span
                      className={cx(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                        on ? 'border-accent bg-accent text-accent-fg' : 'border-dim'
                      )}
                    >
                      {on && <Check size={14} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate font-mono text-xs text-dim">
                        {c.prompt || '(빈 프롬프트)'}
                      </span>
                    </span>
                  </button>
                  <IconButton label={`${c.name} 복제`} onClick={() => s.duplicateCharacter(c.id)}>
                    <Copy size={17} />
                  </IconButton>
                  <IconButton label={`${c.name} 편집`} onClick={() => setEditing(c)}>
                    <Pencil size={17} />
                  </IconButton>
                </li>
              )
            })}
          </ul>
        )}
      </Sheet>
      {editing && <CharacterEditor initial={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
