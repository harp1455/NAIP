import { useState, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { REF_TYPES } from '../nai/constants'
import { pickImageFiles } from '../lib/image'
import { usePrompt } from '../stores/prompt'
import { useRefs, vibeKey } from '../stores/refs'
import { Button, Empty, IconButton, Select, Sheet, SliderRow, Toggle } from './ui'

function useAdder(add: (files: File[]) => Promise<void>): [boolean, string | null, () => void] {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (): void => {
    void pickImageFiles(true).then(async (files) => {
      if (!files.length) return
      setBusy(true)
      setError(null)
      try {
        await add(files)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    })
  }
  return [busy, error, run]
}

export function VibeSheet(props: { onClose: () => void }): ReactNode {
  const { vibes, addVibes, patchVibe, removeVibe } = useRefs()
  const model = usePrompt((p) => p.params.model)
  const [busy, error, add] = useAdder(addVibes)
  return (
    <Sheet
      title="바이브 트랜스퍼"
      onClose={props.onClose}
      footer={
        <Button variant="primary" className="flex-1" disabled={busy} onClick={add}>
          <Plus size={16} />
          {busy ? '불러오는 중…' : '바이브 이미지 추가'}
        </Button>
      }
    >
      <p className="mb-2 text-xs text-dim">
        켜 둔 바이브는 생성 시작 때 한 번 인코딩됩니다(이미지당 2 Anlas). 같은 모델·정보 추출값이면
        저장된 인코딩을 다시 씁니다.
      </p>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {vibes.length === 0 && <Empty>추가된 바이브가 없습니다</Empty>}
      <ul className="flex flex-col gap-2">
        {vibes.map((v) => {
          const encoded = !!v.encodings[vibeKey(model, v.infoExtracted)]
          return (
            <li key={v.id} className="rounded-lg border border-line bg-field p-2.5">
              <div className="flex items-center gap-2.5">
                <img src={v.thumb} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{v.name}</div>
                  <div className="text-xs text-dim">{encoded ? '인코딩됨' : '미인코딩 · 2 Anlas'}</div>
                </div>
                <Toggle
                  label={`${v.name} 사용`}
                  checked={v.enabled}
                  onChange={(enabled) => patchVibe(v.id, { enabled })}
                />
                <IconButton
                  label="삭제"
                  onClick={() => window.confirm('이 바이브를 삭제할까요?') && removeVibe(v.id)}
                >
                  <Trash2 size={17} />
                </IconButton>
              </div>
              <SliderRow
                label="레퍼런스 강도"
                value={v.strength}
                min={0}
                max={1}
                step={0.01}
                format={(x) => x.toFixed(2)}
                onChange={(strength) => patchVibe(v.id, { strength })}
              />
              <SliderRow
                label="정보 추출"
                value={v.infoExtracted}
                min={0.01}
                max={1}
                step={0.01}
                format={(x) => x.toFixed(2)}
                onChange={(infoExtracted) => patchVibe(v.id, { infoExtracted })}
              />
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}

export function CharRefSheet(props: { onClose: () => void }): ReactNode {
  const { charRefs, addCharRefs, patchCharRef, removeCharRef } = useRefs()
  const [busy, error, add] = useAdder(addCharRefs)
  return (
    <Sheet
      title="캐릭터 레퍼런스"
      onClose={props.onClose}
      footer={
        <Button variant="primary" className="flex-1" disabled={busy} onClick={add}>
          <Plus size={16} />
          {busy ? '불러오는 중…' : '레퍼런스 이미지 추가'}
        </Button>
      }
    >
      <p className="mb-2 text-xs text-dim">
        켜 둔 레퍼런스 하나당 이미지 1장마다 5 Anlas가 추가됩니다(Opus 무료 생성에도 부과). V4.5
        모델에서만 동작합니다.
      </p>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {charRefs.length === 0 && <Empty>추가된 레퍼런스가 없습니다</Empty>}
      <ul className="flex flex-col gap-2">
        {charRefs.map((r) => (
          <li key={r.id} className="rounded-lg border border-line bg-field p-2.5">
            <div className="flex items-center gap-2.5">
              <img src={r.thumb} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" />
              <div className="min-w-0 flex-1">
                <div className="mb-1 truncate text-sm">{r.name}</div>
                <Select
                  label="레퍼런스 종류"
                  value={r.type}
                  options={REF_TYPES}
                  onChange={(type) => patchCharRef(r.id, { type })}
                />
              </div>
              <Toggle
                label={`${r.name} 사용`}
                checked={r.enabled}
                onChange={(enabled) => patchCharRef(r.id, { enabled })}
              />
              <IconButton
                label="삭제"
                onClick={() => window.confirm('이 레퍼런스를 삭제할까요?') && removeCharRef(r.id)}
              >
                <Trash2 size={17} />
              </IconButton>
            </div>
            <SliderRow
              label="강도"
              value={r.strength}
              min={0}
              max={1}
              step={0.01}
              format={(x) => x.toFixed(2)}
              onChange={(strength) => patchCharRef(r.id, { strength })}
            />
            <SliderRow
              label="충실도"
              value={r.fidelity}
              min={0}
              max={1}
              step={0.01}
              format={(x) => x.toFixed(2)}
              onChange={(fidelity) => patchCharRef(r.id, { fidelity })}
            />
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
