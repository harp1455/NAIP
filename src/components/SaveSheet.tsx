import { useState, type ReactNode } from 'react'
import { FolderPlus } from 'lucide-react'
import * as db from '../lib/db'
import { STRIP_CONCURRENCY, stripMetadata } from '../lib/strip'
import { cleanFileName, fileNameFor, saveToGallery } from '../lib/native'
import { cx } from '../lib/util'
import { useHistory } from '../stores/history'
import { useSaver } from '../stores/saver'
import { useSettings } from '../stores/settings'
import { Button, Select, Sheet, TextInput } from './ui'

const ROOT = ''

function stem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '')
}

/** 고른 이미지를 폴더·이름·메타데이터 유무를 정해 갤러리(Pictures/NAIP/폴더)에 저장한다 */
export function SaveSheet(): ReactNode {
  const { items, onDone, close } = useSaver()
  const settings = useSettings()
  const [folder, setFolder] = useState(settings.saveFolder)
  const [strip, setStrip] = useState(settings.stripMeta)
  const [names, setNames] = useState<Record<number, string>>(() =>
    Object.fromEntries((items ?? []).map((m) => [m.id, stem(fileNameFor(m.id, m.seed, m.mime))]))
  )
  const [mode, setMode] = useState(settings.nameMode)
  const [base, setBase] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!items) return null

  const folders = settings.saveFolders.includes(folder) || folder === ROOT ? settings.saveFolders : [...settings.saveFolders, folder]
  const busy = progress !== null

  const addFolder = (): void => {
    const name = cleanFileName(window.prompt('새 폴더 이름 (Pictures/NAIP 안에 만들어집니다)', '') ?? '')
    if (!name) return
    if (!settings.saveFolders.includes(name)) settings.patch({ saveFolders: [...settings.saveFolders, name] })
    setFolder(name)
  }
  // 자동 이름: 이름을 적으면 `이름_번호`(같은 폴더·이름의 지난 번호에 이어서), 비우면 날짜·시드로 된 기본 이름
  const cleanBase = cleanFileName(base)
  const counterKey = `${folder}/${cleanBase.toLowerCase()}`
  const startAt = (settings.nameCounters[counterKey] ?? 0) + 1
  const width = Math.max(2, String(startAt + items.length - 1).length)
  const nameOf = (m: (typeof items)[number], i: number): string => {
    const fallback = stem(fileNameFor(m.id, m.seed, m.mime))
    if (mode === 'manual') return cleanFileName(names[m.id] ?? '') || fallback
    return cleanBase ? `${cleanBase}_${String(startAt + i).padStart(width, '0')}` : fallback
  }

  const save = async (): Promise<void> => {
    setError(null)
    settings.patch({ saveFolder: folder, stripMeta: strip, nameMode: mode })
    // 이름은 시작 전에 모두 확정한다 — 같은 이름이 겹치면 뒤에 번호를 붙여 서로 덮어쓰지 않게
    const used = new Set<string>()
    const finalNames = items.map((m, i) => {
      const wanted = nameOf(m, i)
      let name = wanted
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${wanted}_${n}`
      used.add(name.toLowerCase())
      return name
    })
    let saved = 0
    let next = 0
    let failure: Error | null = null
    setProgress(0)
    // 여러 장을 동시에 처리한다 (메타데이터 제거는 워커 수만큼, 그대로 저장은 2장씩)
    const lane = async (): Promise<void> => {
      while (!failure && next < items.length) {
        const i = next++
        const m = items[i]
        try {
          const original = await db.getBlob(m.id, m.mime)
          if (!original) throw new Error('원본을 찾을 수 없는 이미지가 있습니다')
          const blob = strip ? await stripMetadata(original) : original
          const ext = blob.type === 'image/webp' ? 'webp' : 'png'
          const name = finalNames[i]
          await saveToGallery(blob, `${name}.${ext}`, folder || undefined)
          await useHistory.getState().markSaved(m.id, `${folder ? `${folder}/` : ''}${name}.${ext}`)
          saved++
          setProgress(saved)
          // `이름_번호` 꼴로 저장했으면(자동이든 직접 적었든) 다음 자동 번호가 그 뒤부터 이어지게 기록한다
          const numbered = /^(.*)_(\d+)$/.exec(name)
          if (numbered) {
            const key = `${folder}/${numbered[1].toLowerCase()}`
            const counters = useSettings.getState().nameCounters
            if (Number(numbered[2]) > (counters[key] ?? 0)) {
              useSettings.getState().patch({ nameCounters: { ...counters, [key]: Number(numbered[2]) } })
            }
          }
        } catch (e) {
          failure = e as Error
        }
      }
    }
    await Promise.all(Array.from({ length: strip ? STRIP_CONCURRENCY : 2 }, lane))
    setProgress(null)
    if (failure) {
      setError(`${saved}장 저장 후 실패: ${(failure as Error).message}`)
      return
    }
    onDone?.()
    close()
  }

  const choice = (active: boolean): string =>
    cx(
      'h-11 flex-1 rounded-lg border text-sm',
      active ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-field text-dim'
    )

  return (
    <Sheet
      top
      title={`${items.length}장 저장`}
      onClose={() => !busy && close()}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            취소
          </Button>
          <Button variant="primary" className="flex-1" disabled={busy} onClick={() => void save()}>
            {busy ? `저장 중 ${progress}/${items.length}` : `${items.length}장 저장`}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="mb-2 rounded-md bg-danger/15 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="text-xs text-dim">저장 폴더</div>
      <div className="mt-1 flex gap-1.5">
        <Select
          label="저장 폴더"
          className="min-w-0 flex-1"
          value={folder}
          options={[
            { value: ROOT, label: 'Pictures/NAIP (기본)' },
            ...folders.map((f) => ({ value: f, label: `Pictures/NAIP/${f}` }))
          ]}
          onChange={setFolder}
        />
        <Button onClick={addFolder}>
          <FolderPlus size={16} />새 폴더
        </Button>
      </div>

      <div className="mt-3 text-xs text-dim">NAI 메타데이터 (프롬프트·설정 정보)</div>
      <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label="NAI 메타데이터">
        <button type="button" role="radio" aria-checked={!strip} className={choice(!strip)} onClick={() => setStrip(false)}>
          남기기
        </button>
        <button type="button" role="radio" aria-checked={strip} className={choice(strip)} onClick={() => setStrip(true)}>
          지우고 저장
        </button>
      </div>
      <p className="mt-1 text-xs text-dim">
        {strip
          ? '파일에서 프롬프트·시드 등 생성 정보를 모두 지웁니다. 그림은 그대로이고, 앱 히스토리의 정보는 남습니다.'
          : '원본 파일 그대로 저장합니다. 다른 사람이 파일에서 프롬프트를 읽을 수 있습니다.'}
      </p>

      <div className="mt-3 text-xs text-dim">파일 이름</div>
      <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label="파일 이름 정하는 방식">
        <button type="button" role="radio" aria-checked={mode === 'auto'} className={choice(mode === 'auto')} onClick={() => setMode('auto')}>
          자동 (번호)
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'manual'}
          className={choice(mode === 'manual')}
          onClick={() => {
            // 자동으로 매겨진 이름에서 이어서 고칠 수 있게 넘겨준다
            setNames(Object.fromEntries(items.map((m, i) => [m.id, nameOf(m, i)])))
            setMode('manual')
          }}
        >
          하나씩 지정
        </button>
      </div>
      {mode === 'auto' && (
        <>
          <div className="mt-1.5">
            <TextInput label="이름" value={base} onChange={setBase} placeholder="이름 (비우면 날짜·시드로 자동)" />
          </div>
          <p className="mt-1 text-xs text-dim">
            {cleanBase
              ? `"${cleanBase}_번호"로 저장합니다.${startAt > 1 ? ` 이 폴더에서 쓰던 번호에 이어 ${startAt}번부터 매깁니다.` : ''}`
              : '이름을 적으면 뒤에 번호를 붙이고, 비워 두면 날짜와 시드로 된 이름을 자동으로 붙입니다.'}
          </p>
        </>
      )}

      <ul className="mt-2 flex flex-col gap-1.5">
        {items.map((m, i) => (
          <li key={m.id} className="flex items-center gap-2">
            <img src={m.thumb} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
            <div className="min-w-0 flex-1">
              {mode === 'manual' ? (
                <TextInput
                  label={`seed ${m.seed} 파일 이름`}
                  value={names[m.id] ?? ''}
                  onChange={(v) => setNames({ ...names, [m.id]: v })}
                  className="font-mono !text-[13px]"
                />
              ) : (
                <p className="truncate font-mono text-[13px]" data-testid="auto-name">
                  {nameOf(m, i)}
                </p>
              )}
              {m.saved && <p className="mt-0.5 truncate text-[11px] text-ok">이미 저장됨: {m.saved}</p>}
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
