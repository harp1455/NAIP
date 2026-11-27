import { useState, type ReactNode } from 'react'
import { Copy, FolderPlus, Images, Minus, Pencil, Plus, Trash2 } from 'lucide-react'
import { RESOLUTIONS } from '../nai/constants'
import { modelCapabilities } from '../nai/models'
import { cx } from '../lib/util'
import { useCharacters } from '../stores/characters'
import { PositionCanvas } from './PositionCanvas'
import { estimateScenes, useGeneration } from '../stores/generation'
import { useHistory } from '../stores/history'
import { usePrompt } from '../stores/prompt'
import { useRefs } from '../stores/refs'
import { MAX_RESERVE, useScenes, type Scene } from '../stores/scenes'
import { useSource } from '../stores/source'
import { Check } from 'lucide-react'
import { Button, Empty, IconButton, Row, Select, Sheet, TextArea, TextInput, Toggle } from './ui'

function SceneEditor(props: { initial: Partial<Scene>; onClose: () => void }): ReactNode {
  const { folders, saveScene, deleteScene } = useScenes()
  const [name, setName] = useState(props.initial.name ?? '')
  const [folderId, setFolderId] = useState<number | null>(props.initial.folderId ?? null)
  const [prompt, setPrompt] = useState(props.initial.prompt ?? '')
  const [negative, setNegative] = useState(props.initial.negative ?? '')
  const [size, setSize] = useState(props.initial.size ?? null)
  const [cast, setCast] = useState<number[] | undefined>(props.initial.cast)
  const [centers, setCenters] = useState<Record<number, { x: number; y: number }>>(props.initial.castCenters ?? {})
  const mainSize = usePrompt((p) => p.params)
  const sceneModel = usePrompt((p) => p.params.model)
  const { characters, folders: charFolders } = useCharacters()
  const maxChars = modelCapabilities(usePrompt((p) => p.params.model)).maxCharacters
  // 라이브러리에서 지워진 캐릭터는 세지 않는다
  const picked = (cast ?? []).filter((cid) => characters.some((c) => c.id === cid))
  const id = props.initial.id
  const resIndex = size ? RESOLUTIONS.findIndex((r) => r.width === size.width && r.height === size.height) : -1
  return (
    <Sheet
      title={id ? '씬 편집' : '씬 추가'}
      onClose={props.onClose}
      footer={
        <>
          {id !== undefined && (
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm(`"${name}" 씬을 삭제할까요? 이미 만든 이미지는 히스토리에 남습니다.`)) {
                  deleteScene(id)
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
              saveScene({
                id,
                name,
                folderId,
                prompt,
                negative,
                size,
                ...(cast
                  ? {
                      cast: picked,
                      castCenters: Object.fromEntries(
                        Object.entries(centers).filter(([k]) => picked.includes(Number(k)))
                      )
                    }
                  : {})
              })
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
          <TextInput label="이름" value={name} onChange={setName} placeholder="예: 해변 석양" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          묶음
          <Select
            label="묶음"
            value={folderId ?? 0}
            options={[{ value: 0, label: '없음' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
            onChange={(v) => setFolderId(v === 0 ? null : v)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          씬 프롬프트 — 메인 프롬프트 뒤에 덧붙습니다
          <TextArea label="씬 프롬프트" rows={6} value={prompt} onChange={setPrompt} placeholder="beach, sunset, sitting, ..." />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          씬 네거티브 (선택)
          <TextArea label="씬 네거티브" rows={2} value={negative} onChange={setNegative} />
        </label>
        <div className="rounded-lg border border-line bg-field px-3">
          <Row
            label="이 씬의 출연 캐릭터를 따로 정하기"
            hint={cast ? '아래에서 고른 캐릭터만 출연합니다. 2명 이상이면 위치도 정할 수 있습니다' : '프롬프트 화면에서 켜 둔 출연을 그대로 씁니다'}
          >
            <Toggle
              label="이 씬의 출연 캐릭터를 따로 정하기"
              checked={cast !== undefined}
              onChange={(on) => setCast(on ? picked : undefined)}
            />
          </Row>
          {cast !== undefined && (
            <div className="pb-3">
              <p className={cx('pb-1.5 text-xs', picked.length > maxChars ? 'text-danger' : 'text-dim')}>
                {picked.length === 0 ? '아무도 고르지 않으면 캐릭터 없이 생성합니다' : `${picked.length}명 선택`}
                {picked.length > maxChars ? ` — 이 모델은 ${maxChars}명까지만 보냅니다` : ''}
              </p>
              {characters.length === 0 ? (
                <p className="py-2 text-xs text-dim">캐릭터 라이브러리가 비어 있습니다. 프롬프트 화면의 "캐릭터"에서 추가하세요.</p>
              ) : (
                <ul className="scroll-thin flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {characters.map((c) => {
                    const on = picked.includes(c.id)
                    const folderName = charFolders.find((f) => f.id === c.folderId)?.name
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          aria-label={`${c.name} 출연`}
                          onClick={() => setCast(on ? picked.filter((x) => x !== c.id) : [...picked, c.id])}
                          className={cx(
                            'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left',
                            on ? 'border-accent' : 'border-line'
                          )}
                        >
                          <span
                            className={cx(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                              on ? 'border-accent bg-accent text-accent-fg' : 'border-dim'
                            )}
                          >
                            {on && <Check size={14} strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-fg">{c.name}</span>
                          {folderName && <span className="shrink-0 text-[11px] text-dim">{folderName}</span>}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {picked.length >= 2 && (
                <div className="mt-3">
                  <PositionCanvas
                    width={(size ?? mainSize).width}
                    height={(size ?? mainSize).height}
                    model={sceneModel}
                    characters={picked.map((cid) => ({
                      key: cid,
                      name: characters.find((c) => c.id === cid)?.name ?? '?',
                      center: centers[cid] ?? null
                    }))}
                    onChange={(key, center) =>
                      setCenters((prev) => {
                        const next = { ...prev }
                        if (center) next[key] = center
                        else delete next[key]
                        return next
                      })
                    }
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs text-dim">
          해상도
          <Select
            label="해상도"
            value={size ? resIndex : -2}
            options={[
              { value: -2, label: '메인 설정을 따름' },
              ...RESOLUTIONS.map((r, i) => ({ value: i, label: `${r.label} (${r.width}×${r.height})` })),
              ...(size && resIndex < 0 ? [{ value: -1, label: `${size.width}×${size.height}` }] : [])
            ]}
            onChange={(i) => {
              const r = RESOLUTIONS[i]
              if (i === -2) setSize(null)
              else if (r) setSize({ width: r.width, height: r.height })
            }}
          />
        </label>
      </div>
    </Sheet>
  )
}

/** 씬 탭: 장면별 프롬프트에 장수를 예약해 두고 한 번에 돌린다 */
export function ScenePane(props: { bar: (sceneIds: number[], count: number, cost: number) => ReactNode }): ReactNode {
  const s = useScenes()
  // 예상 비용에 영향을 주는 상태 구독
  usePrompt()
  useRefs()
  useSource()
  const [filter, setFilter] = useState<'all' | null | number>('all')
  const [editing, setEditing] = useState<Partial<Scene> | null>(null)
  const allCharacters = useCharacters((c) => c.characters)
  const claims = useGeneration((g) => g.sceneClaims)

  const shown = s.scenes.filter((x) => filter === 'all' || x.folderId === filter)
  const ids = shown.map((x) => x.id)
  const est = estimateScenes(ids)
  const folder = typeof filter === 'number' ? s.folders.find((f) => f.id === filter) : undefined
  const chip = (active: boolean): string =>
    cx(
      'h-9 shrink-0 rounded-full border px-3 text-[13px]',
      active ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
    )
  const showImages = (scene: Scene): void => {
    void useHistory.getState().setFilter({ sceneId: scene.id })
    window.dispatchEvent(new CustomEvent('naip:tab', { detail: 'history' }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2">
        <button type="button" className={chip(filter === 'all')} onClick={() => setFilter('all')}>
          전체 {s.scenes.length}
        </button>
        {s.folders.map((f) => (
          <button key={f.id} type="button" className={chip(filter === f.id)} onClick={() => setFilter(f.id)}>
            {f.name} {s.scenes.filter((x) => x.folderId === f.id).length}
          </button>
        ))}
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-3 text-[13px] text-dim"
          onClick={() => {
            const name = window.prompt('새 묶음 이름', '')
            if (name !== null) setFilter(s.addFolder(name))
          }}
        >
          <FolderPlus size={15} />
          묶음
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-3 py-1.5 text-xs text-dim">
        {folder ? (
          <>
            <span className="min-w-0 flex-1 truncate">묶음: {folder.name}</span>
            <button
              type="button"
              className="h-8 rounded-md px-2 active:bg-raised"
              onClick={() => {
                const name = window.prompt('묶음 이름', folder.name)
                if (name !== null) s.renameFolder(folder.id, name)
              }}
            >
              이름
            </button>
            <button
              type="button"
              className="h-8 rounded-md px-2 text-danger active:bg-raised"
              onClick={() => {
                if (!window.confirm(`"${folder.name}" 묶음을 삭제할까요? 안의 씬은 묶음 없음으로 옮깁니다.`)) return
                s.deleteFolder(folder.id)
                setFilter('all')
              }}
            >
              삭제
            </button>
          </>
        ) : (
          <span className="flex-1">보이는 씬 전체</span>
        )}
        <button type="button" className="h-8 rounded-md px-2 active:bg-raised" disabled={!ids.length} onClick={() => s.bumpReserve(ids, 1)}>
          모두 +1
        </button>
        <button type="button" className="h-8 rounded-md px-2 active:bg-raised" disabled={!est.count} onClick={() => s.clearReserve(ids)}>
          예약 비우기
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {shown.length === 0 ? (
          <Empty>
            씬이 없습니다. 장면별 프롬프트를 만들어 두면 메인 프롬프트·캐릭터와 합쳐 예약한 장수만큼 한 번에 뽑습니다.
          </Empty>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((sc) => (
              <li
                key={sc.id}
                className={cx('rounded-lg border bg-panel', sc.reserve > 0 ? 'border-accent' : 'border-line')}
              >
                <button type="button" className="block w-full px-3 pt-2.5 text-left" onClick={() => setEditing(sc)}>
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{sc.name}</span>
                    {sc.size && (
                      <span className="shrink-0 font-mono text-[11px] text-dim">
                        {sc.size.width}×{sc.size.height}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 line-clamp-2 min-h-8 break-all font-mono text-xs text-dim">
                    {sc.prompt || '(빈 프롬프트)'}
                  </span>
                  {!!claims[sc.id] && (
                    <span className="mt-1 block text-[11px] text-accent">생성 중·대기 {claims[sc.id]}장</span>
                  )}
                  {sc.cast && (
                    <span className="mt-1 block truncate text-[11px] text-accent">
                      출연:{' '}
                      {sc.cast
                        .map((cid) => allCharacters.find((c) => c.id === cid)?.name)
                        .filter(Boolean)
                        .join(', ') || '없음'}
                    </span>
                  )}
                </button>
                <div className="flex items-center px-1 pb-1">
                  <IconButton label={`${sc.name} 편집`} onClick={() => setEditing(sc)}>
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton label={`${sc.name} 복제`} onClick={() => s.duplicateScene(sc.id)}>
                    <Copy size={16} />
                  </IconButton>
                  <IconButton label={`${sc.name} 이미지 보기`} onClick={() => showImages(sc)}>
                    <Images size={16} />
                  </IconButton>
                  <div className="ml-auto flex h-10 items-center rounded-lg border border-line bg-field">
                    <button
                      type="button"
                      aria-label={`${sc.name} 예약 줄이기`}
                      className="flex h-full w-10 items-center justify-center text-dim"
                      onClick={() => s.bumpReserve([sc.id], -1)}
                    >
                      <Minus size={16} />
                    </button>
                    <input
                      aria-label={`${sc.name} 예약 장수`}
                      inputMode="numeric"
                      className={cx(
                        'w-10 bg-transparent text-center font-mono text-sm tabular-nums outline-none',
                        sc.reserve > 0 ? 'text-accent' : 'text-dim'
                      )}
                      value={sc.reserve}
                      onChange={(e) => s.setReserve(sc.id, Math.min(MAX_RESERVE, Number(e.target.value.replace(/\D/g, ''))))}
                    />
                    <button
                      type="button"
                      aria-label={`${sc.name} 예약 늘리기`}
                      className="flex h-full w-10 items-center justify-center text-dim"
                      onClick={() => s.bumpReserve([sc.id], 1)}
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button className="mt-3 w-full" onClick={() => setEditing({ folderId: typeof filter === 'number' ? filter : null })}>
          <Plus size={16} />
          씬 추가
        </Button>
      </div>
      {props.bar(ids, est.count, est.total)}
      {editing && <SceneEditor initial={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
