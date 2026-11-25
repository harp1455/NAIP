import { useState, type ReactNode } from 'react'
import { ImagePlus, Paintbrush, Trash2 } from 'lucide-react'
import { pickImageFiles, pngDataUrl } from '../lib/image'
import { modelCapabilities } from '../nai/models'
import { usePrompt } from '../stores/prompt'
import { useRefs } from '../stores/refs'
import { useSource } from '../stores/source'
import { MaskEditor } from './MaskEditor'
import { Button, Sheet, SliderRow } from './ui'

export function SourceSheet(props: { onClose: () => void }): ReactNode {
  const s = useSource()
  const { width, height } = usePrompt((p) => p.params)
  const [editing, setEditing] = useState(false)
  const model = usePrompt((p) => p.params.model)
  // V5는 인페인트에 레퍼런스를 함께 보낼 수 없다 — 켜 둔 레퍼런스가 있으면 미리 알린다
  const refNote =
    !modelCapabilities(model).referenceWithInpaint && useRefs.getState().charRefs.some((r) => r.enabled)
      ? ' V5 인페인트에는 켜 둔 레퍼런스가 적용되지 않습니다.'
      : ''
  const [error, setError] = useState<string | null>(null)

  const pick = (): void => {
    void pickImageFiles().then(([file]) => {
      if (!file) return
      setError(null)
      s.setImage(file).catch((e: Error) => setError(e.message))
    })
  }

  return (
    <>
      <Sheet
        title={s.image ? (s.mask ? '인페인트' : '이미지 → 이미지') : '이미지 (i2i · 인페인트)'}
        onClose={props.onClose}
        footer={
          s.image ? (
            <>
              <Button variant="danger" onClick={s.clear}>
                <Trash2 size={16} />
                제거
              </Button>
              <Button className="flex-1" onClick={pick}>
                <ImagePlus size={16} />
                이미지 변경
              </Button>
            </>
          ) : (
            <Button variant="primary" className="flex-1" onClick={pick}>
              <ImagePlus size={16} />
              이미지 선택
            </Button>
          )
        }
      >
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
        {!s.image ? (
          <div className="px-2 py-8 text-center text-sm text-dim">
            <p>원본 이미지를 고르면 i2i로 생성합니다.</p>
            <p className="mt-1">마스크를 칠하면 칠한 부분만 다시 그리는 인페인트가 됩니다.</p>
            <p className="mt-1">히스토리의 이미지에서도 바로 보낼 수 있습니다.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="relative mx-auto max-h-[42vh] overflow-hidden rounded-lg bg-black">
              <img
                src={pngDataUrl(s.image)}
                alt="원본 이미지"
                className="block max-h-[42vh] w-auto max-w-full"
              />
              {s.mask && (
                <img
                  src={s.mask}
                  alt=""
                  className="pointer-events-none absolute inset-0 h-full w-full opacity-60"
                />
              )}
            </div>
            <p className="text-center text-xs text-dim">
              원본 {s.width}×{s.height} → 생성 {width}×{height}
              {s.width !== width || s.height !== height ? ' (전송 시 맞춰 리사이즈)' : ''}
            </p>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setEditing(true)}>
                <Paintbrush size={16} />
                {s.mask ? '마스크 편집' : '마스크 칠하기 (인페인트)'}
              </Button>
              {s.mask && <Button onClick={() => s.setMask(null)}>마스크 제거</Button>}
            </div>
            <SliderRow
              label="강도 (Strength)"
              value={s.strength}
              min={0.01}
              max={1}
              step={0.01}
              format={(v) => v.toFixed(2)}
              onChange={(strength) => s.patch({ strength })}
            />
            <SliderRow
              label="노이즈 (Noise)"
              value={s.noise}
              min={0}
              max={0.99}
              step={0.01}
              format={(v) => v.toFixed(2)}
              onChange={(noise) => s.patch({ noise })}
            />
            <p className="text-xs text-dim">
              {s.mask
                ? `인페인트는 모델의 인페인팅 버전으로 자동 전환되어 요청됩니다.${refNote}`
                : '강도가 낮을수록 원본에 가깝고, 높을수록 많이 바뀝니다.'}
            </p>
          </div>
        )}
      </Sheet>
      {editing && s.image && (
        <MaskEditor
          image={s.image}
          width={s.width}
          height={s.height}
          mask={s.mask}
          onSave={s.setMask}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  )
}
