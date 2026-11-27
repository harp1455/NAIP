import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Dices,
  FolderPlus,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { modelCapabilities } from '../nai/models'
import {
  checkPeopleCount,
  createDrawState,
  fixPeopleCount,
  resolveCast,
  type CastResolution,
  type DrawState
} from '../nai/cast'
import { cx } from '../lib/util'
import { snapshotCastPlan, useCharacters, type Character } from '../stores/characters'
import { mergePromptParts, usePrompt } from '../stores/prompt'
import { CharacterEditor } from './CharacterEditor'
import { PositionCanvas } from './PositionCanvas'
import { chipClass, SearchBox, Segmented, slotSummary, SlotEditor, useLibraryFilter } from './SlotEditor'
import { Button, Empty, IconButton, Row, Sheet, Toggle } from './ui'

let positionPanelOpen = false
let optionsPanelOpen = false

/** "이번 장 예시" — 지금 슬롯 설정으로 한 장씩 뽑아 본다 (순차·배치에 한 번은 이어서) */
function CastPreview(props: { max: number }): ReactNode {
  const s = useCharacters()
  const p = usePrompt()
  const state = useRef<DrawState>(createDrawState())
  const [n, setN] = useState(1)
  const [nonce, setNonce] = useState(0)
  // 슬롯·라이브러리·한도가 바뀌거나 "다음 장"을 누르면 다시 뽑는다
  const res: CastResolution = useMemo(
    () => resolveCast(snapshotCastPlan(), state.current, Math.random, props.max),
    [s.slots, s.characters, s.options, props.max, nonce] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const main = mergePromptParts(p)
  const check = checkPeopleCount(main, res.chars.length)
  const fix = s.options.autoCountTags ? fixPeopleCount(main, res.chars) : null
  if (!s.slots.some((x) => x.enabled)) return null
  return (
    <div className="mt-3 rounded-lg border border-line bg-field p-2.5">
      <div className="mb-1.5 flex items-center gap-1">
        <h3 className="flex-1 text-xs text-dim">
          이번 장 예시 · {n}장째 · {res.chars.length}명
        </h3>
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-dim active:bg-raised"
          onClick={() => {
            state.current = createDrawState()
            setN(1)
            setNonce(nonce + 1)
          }}
        >
          <RotateCcw size={13} />
          처음부터
        </button>
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-accent active:bg-raised"
          onClick={() => {
            setN(n + 1)
            setNonce(nonce + 1)
          }}
        >
          <Dices size={14} />
          다음 장
        </button>
      </div>
      {res.chars.length === 0 ? (
        <p className="py-2 text-center text-xs text-dim">이번 장에는 캐릭터가 나오지 않습니다</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {res.chars.map((c) => (
            <li key={`${c.slotId}-${c.charId}`} className="rounded-md border border-line bg-panel px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                <span className="shrink-0 text-[11px] text-dim">
                  슬롯 {s.slots.findIndex((x) => x.id === c.slotId) + 1}
                  {c.center ? ' · 위치 지정' : ''}
                </span>
              </div>
              {c.variations.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.variations.map((v) => (
                    <span key={v.groupId} className="rounded-full bg-raised px-2 py-0.5 text-[11px]">
                      {v.group}: {v.label}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-1 line-clamp-3 break-words font-mono text-[11px] text-dim">{c.prompt}</p>
            </li>
          ))}
        </ul>
      )}
      {res.notes.map((note) => (
        <p key={note} className={cx('mt-1.5 text-xs', res.dropped.length && note.startsWith('모델') ? 'text-danger' : 'text-dim')}>
          {note}
        </p>
      ))}
      {check?.conflict && (
        <p className={cx('mt-1.5 text-xs', fix ? 'text-dim' : 'text-danger')}>
          메인 프롬프트의 인원 태그({check.tags.join(', ')})와 캐릭터 {check.actual}명이 맞지 않습니다
          {fix ? ` → 보낼 때 "${fix.to}"(으)로 고칩니다` : ''}
        </p>
      )}
    </div>
  )
}

function CastOptionsPanel(): ReactNode {
  const { options, setOptions } = useCharacters()
  const [open, setOpenState] = useState(optionsPanelOpen)
  const setOpen = (v: boolean): void => {
    optionsPanelOpen = v
    setOpenState(v)
  }
  return (
    <div className="mt-3 rounded-lg border border-line bg-field">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm"
      >
        <SlidersHorizontal size={16} className="text-accent" />
        <span className="flex-1">뽑기 설정</span>
        <span className="text-xs text-dim">
          {options.scope === 'batch' ? '배치에 한 번' : '장마다'}
          {options.allowDuplicates ? ' · 중복 허용' : ''}
          {options.autoCountTags ? ' · 인원 자동' : ''}
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-3 pb-2 pt-2">
          <h4 className="mb-1 text-xs text-dim">무작위·순차·확률 슬롯을 뽑는 때</h4>
          <Segmented
            label="뽑는 때"
            value={options.scope}
            options={[
              { value: 'image', label: '장마다' },
              { value: 'batch', label: '배치에 한 번' }
            ]}
            onChange={(scope) => setOptions({ scope })}
          />
          <Row label="같은 캐릭터 중복 허용" hint="끄면 한 장에 같은 캐릭터가 두 슬롯에 나오지 않습니다">
            <Toggle
              label="같은 캐릭터 중복 허용"
              checked={options.allowDuplicates}
              onChange={(allowDuplicates) => setOptions({ allowDuplicates })}
            />
          </Row>
          <Row label="씬마다 따로 뽑기" hint="씬 여러 개를 돌릴 때 씬이 바뀌면 순서·배치 뽑기를 처음부터">
            <Toggle label="씬마다 따로 뽑기" checked={options.perScene} onChange={(perScene) => setOptions({ perScene })} />
          </Row>
          <Row label="인원 태그 자동 고침" hint="메인 프롬프트의 2girls·solo 등을 실제 캐릭터 수에 맞춰 고쳐 보냅니다">
            <Toggle
              label="인원 태그 자동 고침"
              checked={options.autoCountTags}
              onChange={(autoCountTags) => setOptions({ autoCountTags })}
            />
          </Row>
        </div>
      )}
    </div>
  )
}

export function CharacterSheet(props: { onClose: () => void }): ReactNode {
  const s = useCharacters()
  const model = usePrompt((p) => p.params.model)
  const max = modelCapabilities(model).maxCharacters
  const lib = useLibraryFilter(s.characters)
  const [editing, setEditing] = useState<Partial<Character> | null>(null)
  const [slotOpen, setSlotOpen] = useState<number | null>(null)
  // 위치 판을 열어 두었으면 시트를 다시 열어도 그대로 열어 둔다
  const [posOpen, setPosOpenState] = useState(positionPanelOpen)
  const setPosOpen = (open: boolean): void => {
    positionPanelOpen = open
    setPosOpenState(open)
  }
  const { width, height } = usePrompt((p) => p.params)

  const fixedChars = new Set(s.slots.filter((x) => x.mode === 'fixed' && x.charId !== null).map((x) => x.charId))
  const enabled = s.slots.filter((x) => x.enabled)
  const folder = typeof lib.folder === 'number' ? s.folders.find((f) => f.id === lib.folder) : undefined

  return (
    <>
      <Sheet
        title="캐릭터"
        onClose={props.onClose}
        footer={
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => setEditing({ folderId: typeof lib.folder === 'number' ? lib.folder : null })}
          >
            <Plus size={16} />
            캐릭터 추가
          </Button>
        }
      >
        <div className="mb-1 flex items-center">
          <h3 className="text-xs text-dim">
            출연 슬롯{' '}
            <span className={cx('font-mono', enabled.length > max && 'text-danger')}>
              {enabled.length}/{max}
            </span>
            {enabled.length > max && <span className="text-danger"> — 넘는 캐릭터는 뒤에서부터 빼고 보냅니다</span>}
          </h3>
          {s.slots.length > 0 && (
            <button type="button" className="ml-auto h-8 px-2 text-xs text-dim" onClick={s.clearSlots}>
              모두 내리기
            </button>
          )}
        </div>
        {s.slots.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-dim">
            아래 라이브러리에서 캐릭터를 누르면 고정 슬롯으로 출연합니다. 무작위·순차·확률 슬롯은 "슬롯 추가"로 만드세요
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {s.slots.map((slot, i) => {
              const sum = slotSummary(slot, s.characters, s.folders)
              return (
                <li key={slot.id} className="rounded-lg border border-line bg-field">
                  <div className="flex items-center gap-1 py-1 pl-3 pr-1">
                    <Toggle
                      label={`슬롯 ${i + 1} 사용`}
                      checked={slot.enabled}
                      onChange={(on) => s.patchSlot(slot.id, { enabled: on })}
                    />
                    <button
                      type="button"
                      aria-label={`슬롯 ${i + 1} 편집`}
                      className="ml-2 flex min-w-0 flex-1 flex-col py-1 text-left"
                      onClick={() => setSlotOpen(slot.id)}
                    >
                      <span className={cx('truncate', !slot.enabled && 'text-dim')}>{sum.title}</span>
                      <span className={cx('truncate text-[11px]', slot.mode === 'fixed' ? 'text-dim' : 'text-accent')}>
                        {i + 1}번 · {slot.enabled ? sum.sub : '비활성'}
                      </span>
                    </button>
                    {slot.center && slot.enabled && (
                      <MapPin size={15} className="mr-1 shrink-0 text-accent" aria-label="위치 지정됨" />
                    )}
                    <IconButton label="위로" disabled={i === 0} onClick={() => s.moveSlot(slot.id, -1)}>
                      <ArrowUp size={17} />
                    </IconButton>
                    <IconButton label="아래로" disabled={i === s.slots.length - 1} onClick={() => s.moveSlot(slot.id, 1)}>
                      <ArrowDown size={17} />
                    </IconButton>
                    <IconButton label={`슬롯 ${i + 1} 내리기`} onClick={() => s.removeSlot(slot.id)}>
                      <X size={17} />
                    </IconButton>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <Button className="mt-1.5 w-full" onClick={() => setSlotOpen(s.addSlot({ mode: 'random' }))}>
          <Plus size={16} />
          슬롯 추가 (무작위·순차·확률)
        </Button>

        <CastOptionsPanel />
        <CastPreview max={max} />

        {enabled.length > 0 && (
          <div className="mt-3 rounded-lg border border-line bg-field">
            <button
              type="button"
              aria-expanded={posOpen}
              onClick={() => setPosOpen(!posOpen)}
              className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm"
            >
              <MapPin size={16} className="text-accent" />
              <span className="flex-1">위치 정하기</span>
              <span className="text-xs text-dim">
                {enabled.filter((x) => x.center).length ? `${enabled.filter((x) => x.center).length}자리 지정` : '모두 AI 선택'}
              </span>
            </button>
            {posOpen && (
              <div className="border-t border-line p-3">
                <PositionCanvas
                  width={width}
                  height={height}
                  model={model}
                  characters={enabled.map((x) => ({
                    key: x.id,
                    name: x.mode === 'fixed' ? slotSummary(x, s.characters, s.folders).short : `${s.slots.indexOf(x) + 1}번`,
                    center: x.center
                  }))}
                  onChange={(key, center) => s.patchSlot(key, { center })}
                />
                <p className="mt-1 text-[11px] text-dim">위치는 슬롯마다 정합니다 — 그 자리에 누가 뽑혀도 같은 위치에 둡니다.</p>
              </div>
            )}
          </div>
        )}

        <h3 className="mb-1 mt-5 text-xs text-dim">라이브러리 — 누르면 고정 슬롯으로 출연</h3>
        {s.characters.length > 6 && <SearchBox label="라이브러리 찾기" value={lib.query} onChange={lib.setQuery} />}
        <div className="scroll-thin -mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 pb-2">
          <button type="button" className={chipClass(lib.folder === 'all')} onClick={() => lib.setFolder('all')}>
            전체 {s.characters.length}
          </button>
          <button type="button" className={chipClass(lib.folder === null)} onClick={() => lib.setFolder(null)}>
            미분류 {s.characters.filter((c) => c.folderId === null).length}
          </button>
          {s.folders.map((f) => (
            <button key={f.id} type="button" className={chipClass(lib.folder === f.id)} onClick={() => lib.setFolder(f.id)}>
              {f.name} {s.characters.filter((c) => c.folderId === f.id).length}
            </button>
          ))}
          <button
            type="button"
            className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-3 text-[13px] text-dim"
            onClick={() => {
              const name = window.prompt('새 폴더 이름', '')
              if (name !== null) lib.setFolder(s.addFolder(name))
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
                lib.setFolder('all')
              }}
            >
              폴더 삭제
            </button>
          </div>
        )}
        {lib.shown.length === 0 ? (
          <Empty>{lib.query ? '찾는 캐릭터가 없습니다' : '이 폴더에 캐릭터가 없습니다'}</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {lib.shown.map((c) => {
              const on = fixedChars.has(c.id)
              const groups = c.variations.filter((g) => g.mode !== 'off' && g.items.length).length
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
                    onClick={() => s.toggleFixed(c.id)}
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
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{c.name}</span>
                        {groups > 0 && (
                          <span className="shrink-0 rounded-full bg-raised px-1.5 text-[10px] text-accent">변형 {groups}</span>
                        )}
                      </span>
                      <span className="block truncate font-mono text-xs text-dim">
                        {c.base || '(빈 고정 프롬프트)'}
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
      {slotOpen !== null && <SlotEditor slotId={slotOpen} onClose={() => setSlotOpen(null)} />}
      {editing && <CharacterEditor initial={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
