import { useState, type ReactNode } from 'react'
import { FolderPlus } from 'lucide-react'
import * as db from '../lib/db'
import { stripMetadata } from '../lib/image'
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
  const [batch, setBatch] = useState('')
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
  const applyBatch = (): void => {
    const base = cleanFileName(batch)
    if (!base) return
    const width = Math.max(2, String(items.length).length)
    setNames(Object.fromEntries(items.map((m, i) => [m.id, `${base}_${String(i + 1).padStart(width, '0')}`])))
  }

  const save = async (): Promise<void> => {
    setError(null)
    settings.patch({ saveFolder: folder, stripMeta: strip })
    // 같은 이름이 겹치면 뒤에 번호를 붙여 서로 덮어쓰지 않게 한다
    const used = new Set<string>()
    let saved = 0
    try {
      for (const [i, m] of items.entries()) {
        setProgress(i)
        const original = await db.getBlob(m.id, m.mime)
        if (!original) throw new Error('원본을 찾을 수 없는 이미지가 있습니다')
        const blob = strip ? await stripMetadata(original) : original
        const ext = blob.type === 'image/webp' ? 'webp' : 'png'
        const base = cleanFileName(names[m.id] ?? '') || stem(fileNameFor(m.id, m.seed, m.mime))
        let name = base
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`
        used.add(name.toLowerCase())
        await saveToGallery(blob, `${name}.${ext}`, folder || undefined)
        await useHistory.getState().markSaved(m.id, `${folder ? `${folder}/` : ''}${name}.${ext}`)
        saved++
      }
      onDone?.()
      close()
    } catch (e) {
      setError(`${saved}장 저장 후 실패: ${(e as Error).message}`)
    } finally {
      setProgress(null)
    }
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
            {busy ? `저장 중 ${progress + 1}/${items.length}` : `${items.length}장 저장`}
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

      {items.length > 1 && (
        <>
          <div className="mt-3 text-xs text-dim">이름 한꺼번에 정하기 — 뒤에 번호가 붙습니다</div>
          <div className="mt-1 flex gap-1.5">
            <TextInput label="일괄 이름" value={batch} onChange={setBatch} placeholder="예: 해변 마요" />
            <Button onClick={applyBatch} disabled={!cleanFileName(batch)}>
              적용
            </Button>
          </div>
        </>
      )}

      <div className="mt-3 text-xs text-dim">파일 이름</div>
      <ul className="mt-1 flex flex-col gap-1.5">
        {items.map((m) => (
          <li key={m.id} className="flex items-center gap-2">
            <img src={m.thumb} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
            <div className="min-w-0 flex-1">
              <TextInput
                label={`seed ${m.seed} 파일 이름`}
                value={names[m.id] ?? ''}
                onChange={(v) => setNames({ ...names, [m.id]: v })}
                className="font-mono !text-[13px]"
              />
              {m.saved && <p className="mt-0.5 truncate text-[11px] text-ok">이미 저장됨: {m.saved}</p>}
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
