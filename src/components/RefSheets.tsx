import { useState, type ReactNode } from 'react'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { REF_TYPES } from '../nai/constants'
import { modelCapabilities } from '../nai/models'
import { effectiveSameOutfit, referenceBlockReason, referenceCaption, referencesForModel } from '../nai/reference'
import { pickImageFiles } from '../lib/image'
import { cx } from '../lib/util'
import { useSource } from '../stores/source'
import { usePrompt } from '../stores/prompt'
import { useRefs, vibeKey } from '../stores/refs'
import { Button, Empty, IconButton, Row, Select, Sheet, SliderRow, Toggle } from './ui'

function useAdder(
  add: (files: File[]) => Promise<void>,
  accept?: string
): [boolean, string | null, () => void] {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (): void => {
    void pickImageFiles(true, accept).then(async (files) => {
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
  const [busy, error, add] = useAdder(addVibes, 'image/*,.naiv4vibe,application/json')
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
        저장된 인코딩을 다시 씁니다. NovelAI에서 내보낸 .naiv4vibe 파일도 추가할 수 있습니다(인코딩 비용 없음).
      </p>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {vibes.length === 0 && <Empty>추가된 바이브가 없습니다</Empty>}
      <ul className="flex flex-col gap-2">
        {vibes.map((v) => {
          const encoded = !!v.encodings[vibeKey(model, v.infoExtracted)]
          return (
            <li key={v.id} className="rounded-lg border border-line bg-field p-2.5">
              <div className="flex items-center gap-2.5">
                {v.thumb ? (
                  <img src={v.thumb} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" />
                ) : (
                  <div className="h-14 w-14 shrink-0 rounded-md bg-raised" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{v.name}</div>
                  <div className="text-xs text-dim">{encoded ? '인코딩됨' : v.image ? '미인코딩 · 2 Anlas' : '이 모델·추출값의 인코딩 없음'}</div>
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

/**
 * 레퍼런스 Strength 슬라이더. 상한이 1을 넘는 모델(V5, 0~5)은 꺾인 눈금을 쓴다 —
 * 앞 절반이 0~1, 뒤 절반이 1~5 라서 자주 쓰는 0~1 구간을 여전히 세밀하게 고를 수 있다.
 */
function StrengthSlider(props: { value: number; max: number; onChange: (v: number) => void }): ReactNode {
  const extended = props.max > 1
  const value = Math.min(props.value, props.max)
  const toPos = (v: number): number => (!extended ? v * 100 : v <= 1 ? v * 100 : 100 + ((v - 1) / (props.max - 1)) * 100)
  const fromPos = (pos: number): number =>
    !extended || pos <= 100
      ? Math.round(pos) / 100
      : // 뒤 절반은 0.05 단위
        Math.round((1 + ((pos - 100) / 100) * (props.max - 1)) * 20) / 20
  return (
    <label className="block py-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span>강도 (Strength)</span>
        <span className={cx('font-mono text-xs tabular-nums', value > 1 ? 'text-accent' : 'text-dim')}>
          {value.toFixed(2)}
          {props.value > props.max ? ` (저장값 ${props.value.toFixed(2)})` : ''}
        </span>
      </div>
      <input
        type="range"
        aria-label="강도"
        className="mt-1 h-8 w-full"
        min={0}
        max={extended ? 200 : 100}
        step={1}
        value={toPos(value)}
        onChange={(e) => props.onChange(fromPos(Number(e.target.value)))}
      />
      {extended && (
        <div className="flex justify-between font-mono text-[10px] text-dim">
          <span>0</span>
          <span>1</span>
          <span>{props.max}</span>
        </div>
      )}
    </label>
  )
}

export function CharRefSheet(props: { onClose: () => void }): ReactNode {
  const { charRefs, addCharRefs, patchCharRef, removeCharRef, duplicateCharRef, setAllCharRefs } = useRefs()
  const model = usePrompt((p) => p.params.model)
  const inpaint = useSource((x) => !!(x.image && x.mask))
  const caps = modelCapabilities(model)
  const [busy, error, add] = useAdder(addCharRefs)
  const blocked = referenceBlockReason(model, inpaint)
  const sent = referencesForModel(charRefs, model, inpaint)
  const anyOn = charRefs.some((r) => r.enabled)
  return (
    <Sheet
      title="정밀 레퍼런스"
      onClose={props.onClose}
      actions={
        charRefs.length > 0 && (
          <button type="button" className="h-10 px-2 text-xs text-dim" onClick={() => setAllCharRefs(!anyOn)}>
            {anyOn ? '모두 끄기' : '모두 켜기'}
          </button>
        )
      }
      footer={
        <Button variant="primary" className="flex-1" disabled={busy} onClick={add}>
          <Plus size={16} />
          {busy ? '불러오는 중…' : '레퍼런스 이미지 추가'}
        </Button>
      }
    >
      {blocked ? (
        <p role="alert" className="mb-2 rounded-md bg-danger/15 px-2.5 py-1.5 text-xs text-danger">
          {blocked}
        </p>
      ) : (
        <p className="mb-2 rounded-md bg-raised px-2.5 py-1.5 text-xs">
          {sent.length > 0
            ? `레퍼런스 ${sent.length}개 사용 — 이미지 1장마다 ${sent.length * 5} Anlas (Opus 무료 생성에도 부과)`
            : '켜 둔 레퍼런스 하나당 이미지 1장마다 5 Anlas가 듭니다'}
        </p>
      )}
      <p className="mb-2 text-xs text-dim">
        {caps.outfitReference
          ? 'V5: 캐릭터·스타일·의상을 자유롭게 섞을 수 있습니다. 강도는 5까지 올릴 수 있고, 스타일이 잘 안 묻으면 강도를 먼저 올려 보세요.'
          : 'V4.5: 캐릭터·스타일 레퍼런스. 의상 레퍼런스와 1을 넘는 강도는 V5 Full·Curated에서 쓸 수 있습니다.'}
      </p>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {charRefs.length === 0 && <Empty>추가된 레퍼런스가 없습니다</Empty>}
      <ul className="flex flex-col gap-2">
        {charRefs.map((r) => {
          const sameOutfit = effectiveSameOutfit(r.type, r.sameOutfit)
          const unsent = r.enabled && !blocked && referenceCaption(r.type, r.sameOutfit, caps) === null
          return (
            <li key={r.id} className={cx('rounded-lg border bg-field p-2.5', r.enabled ? 'border-line' : 'border-line opacity-70')}>
              <div className="flex items-center gap-2">
                <img src={r.thumb} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="mb-1 block max-w-full truncate text-left text-sm"
                    title="이름 바꾸기"
                    onClick={() => {
                      const name = window.prompt('레퍼런스 이름', r.name)
                      if (name?.trim()) patchCharRef(r.id, { name: name.trim() })
                    }}
                  >
                    {r.name}
                  </button>
                  <Select
                    label={`${r.name} 종류`}
                    value={r.type}
                    options={REF_TYPES}
                    onChange={(type) => patchCharRef(r.id, { type, sameOutfit: undefined })}
                  />
                </div>
                <Toggle
                  label={`${r.name} 사용`}
                  checked={r.enabled}
                  onChange={(enabled) => patchCharRef(r.id, { enabled })}
                />
              </div>
              {unsent && (
                <p className="mt-1.5 text-xs text-danger">의상 레퍼런스는 V5 전용이라 이 모델에는 보내지 않습니다.</p>
              )}
              {caps.outfitReference && sameOutfit !== undefined && (
                <Row label="같은 의상 선호" hint="켜면 레퍼런스 캐릭터의 옷차림을 더 가깝게 따릅니다">
                  <Toggle
                    label={`${r.name} 같은 의상 선호`}
                    checked={sameOutfit}
                    onChange={(v) => patchCharRef(r.id, { sameOutfit: v })}
                  />
                </Row>
              )}
              <StrengthSlider
                value={r.strength}
                max={caps.referenceStrengthMax}
                onChange={(strength) => patchCharRef(r.id, { strength })}
              />
              {caps.referenceFidelity && (
                <SliderRow
                  label="충실도 (Fidelity)"
                  value={r.fidelity}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(x) => x.toFixed(2)}
                  onChange={(fidelity) => patchCharRef(r.id, { fidelity })}
                />
              )}
              <div className="flex justify-end gap-1">
                <button
                  type="button"
                  className="flex h-9 items-center gap-1 rounded-md px-2 text-xs text-dim active:bg-raised"
                  title="같은 이미지를 다른 종류로도 쓰려면 복제한 뒤 종류를 바꾸세요"
                  onClick={() => duplicateCharRef(r.id)}
                >
                  <Copy size={14} />
                  복제
                </button>
                <button
                  type="button"
                  className="flex h-9 items-center gap-1 rounded-md px-2 text-xs text-danger active:bg-raised"
                  onClick={() => window.confirm('이 레퍼런스를 삭제할까요?') && removeCharRef(r.id)}
                >
                  <Trash2 size={14} />
                  삭제
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}
