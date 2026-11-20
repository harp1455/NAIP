import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ImagePlus } from 'lucide-react'
import { directorCost, UPSCALE_ANLAS_COST } from '../nai/anlas'
import { augmentImage, upscaleImage, type DirectorMethod } from '../nai/client'
import { blobToBase64, loadImage, makeThumb, pickImageFiles, toPngBase64 } from '../lib/image'
import { cx, uid } from '../lib/util'
import { useDirector } from '../stores/director'
import { useGeneration } from '../stores/generation'
import { useHistory } from '../stores/history'
import { useSettings } from '../stores/settings'
import { Button, Select, Sheet, SliderRow, TextInput } from './ui'

type Tool = DirectorMethod | 'upscale'

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'upscale', label: '업스케일', hint: '해상도를 2배로 키웁니다 (V5 Curated 업스케일러)' },
  { id: 'bg-removal', label: '배경 제거', hint: '인물만 남기고 배경을 투명하게 만듭니다' },
  { id: 'lineart', label: '선화', hint: '이미지를 선화로 바꿉니다' },
  { id: 'sketch', label: '스케치', hint: '이미지를 스케치로 바꿉니다' },
  { id: 'colorize', label: '채색', hint: '선화·스케치에 색을 입힙니다' },
  { id: 'emotion', label: '표정', hint: '캐릭터의 표정을 바꿉니다' },
  { id: 'declutter', label: '정리', hint: '글자·말풍선·효과선 등을 지웁니다' },
  { id: 'declutter-keep-bubbles', label: '정리(말풍선 유지)', hint: '말풍선은 남기고 정리합니다' }
]

const EMOTIONS = [
  ['neutral', '무표정'], ['happy', '행복'], ['sad', '슬픔'], ['angry', '화남'], ['scared', '겁먹음'],
  ['surprised', '놀람'], ['shy', '수줍음'], ['disgusted', '혐오'], ['smug', '우쭐'], ['bored', '지루함'],
  ['laughing', '웃음'], ['irritated', '짜증'], ['aroused', '흥분'], ['embarrassed', '당황'], ['worried', '걱정'],
  ['love', '사랑'], ['determined', '결의'], ['hurt', '아픔'], ['playful', '장난기']
].map(([value, label]) => ({ value, label: `${label} (${value})` }))

export function DirectorSheet(): ReactNode {
  const { image, setImage, close } = useDirector()
  const sub = useSettings((s) => s.subscription)
  const token = useSettings((s) => s.token)
  const generating = useGeneration((s) => s.running)
  const [tool, setTool] = useState<Tool>('upscale')
  const [url, setUrl] = useState<string | null>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [prompt, setPrompt] = useState('')
  const [defry, setDefry] = useState(0)
  const [emotion, setEmotion] = useState('happy')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!image) {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(image)
    setUrl(u)
    void loadImage(u).then((img) => setDims({ w: img.naturalWidth, h: img.naturalHeight }))
    return () => URL.revokeObjectURL(u)
  }, [image])
  useEffect(() => () => abort.current?.abort(), [])

  const info = TOOLS.find((t) => t.id === tool)!
  const cost =
    tool === 'upscale' ? UPSCALE_ANLAS_COST : directorCost(tool, dims.w, dims.h, sub?.tier === 'opus')

  const pick = (): void => {
    void pickImageFiles().then(async ([file]) => {
      if (!file) return
      const { base64 } = await toPngBase64(file)
      setImage(await (await fetch(`data:image/png;base64,${base64}`)).blob())
      setNote(null)
    })
  }

  const run = async (): Promise<void> => {
    if (!image) return
    if (!token) return setNote({ error: true, text: 'API 토큰을 먼저 설정해 주세요' })
    setBusy(true)
    setNote(null)
    abort.current = new AbortController()
    try {
      let result: Blob
      if (tool === 'upscale') {
        result = await upscaleImage(token, image, abort.current.signal)
      } else {
        const withPrompt = tool === 'colorize' || tool === 'emotion'
        result = await augmentImage(
          token,
          {
            method: tool,
            imageBase64: await blobToBase64(image),
            width: dims.w,
            height: dims.h,
            ...(withPrompt
              ? { prompt: tool === 'emotion' ? `${emotion};;${prompt}` : prompt, defry }
              : {})
          },
          abort.current.signal
        )
      }
      const out = await loadImage(result)
      const id = uid()
      await useHistory.getState().add(
        {
          id,
          ts: Date.now(),
          thumb: await makeThumb(result),
          width: out.naturalWidth,
          height: out.naturalHeight,
          seed: 0,
          model: tool === 'upscale' ? 'upscale' : `director:${tool}`,
          kind: tool === 'upscale' ? 'upscale' : 'director',
          prompt: tool === 'emotion' ? `${emotion};;${prompt}` : tool === 'colorize' ? prompt : '',
          negative: '',
          mime: 'image/png'
        },
        result
      )
      useGeneration.getState().setLatest(id)
      // 결과를 작업 이미지로 올려 이어서 다른 도구를 쓸 수 있게 한다
      setImage(result)
      setNote({ error: false, text: `${info.label} 완료 — 히스토리에 저장했습니다` })
      void useSettings.getState().refreshSubscription()
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setNote({ error: true, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="디렉터 툴 · 업스케일"
      onClose={close}
      footer={
        <>
          <Button onClick={pick} disabled={busy}>
            <ImagePlus size={16} />
            {image ? '변경' : '이미지 선택'}
          </Button>
          {busy ? (
            <Button className="flex-1" onClick={() => abort.current?.abort()}>
              취소 · 처리 중…
            </Button>
          ) : (
            <Button variant="primary" className="flex-1" disabled={!image || generating} onClick={() => void run()}>
              {info.label} 실행 · {cost > 0 ? `${cost} Anlas` : '무료'}
            </Button>
          )}
        </>
      }
    >
      {url ? (
        <div className="mx-auto mb-2 flex max-h-[38vh] justify-center overflow-hidden rounded-lg bg-[repeating-conic-gradient(#222_0_25%,#2c2c2c_0_50%)] bg-[length:16px_16px]">
          <img src={url} alt="작업 이미지" className="max-h-[38vh] w-auto max-w-full object-contain" />
        </div>
      ) : (
        <p className="px-2 py-8 text-center text-sm text-dim">
          이미지를 고르거나, 히스토리의 이미지 화면에서 "도구"를 누르세요.
        </p>
      )}
      {url && (
        <p className="mb-2 text-center font-mono text-xs text-dim">
          {dims.w}×{dims.h}
          {tool === 'upscale' && dims.w ? ` → ${dims.w * 2}×${dims.h * 2}` : ''}
        </p>
      )}
      {note && (
        <p role="status" className={cx('mb-2 rounded-md px-2.5 py-1.5 text-xs', note.error ? 'bg-danger/15 text-danger' : 'bg-raised text-fg')}>
          {note.text}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="도구">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tool === t.id}
            onClick={() => setTool(t.id)}
            className={cx(
              'h-10 rounded-full border px-3.5 text-[13px]',
              tool === t.id ? 'border-accent bg-accent/15 text-accent' : 'border-line text-dim'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-dim">{info.hint}</p>
      {tool === 'emotion' && (
        <label className="mt-3 flex flex-col gap-1 text-xs text-dim">
          표정
          <Select label="표정" value={emotion} options={EMOTIONS} onChange={setEmotion} />
        </label>
      )}
      {(tool === 'colorize' || tool === 'emotion') && (
        <div className="mt-3">
          <label className="flex flex-col gap-1 text-xs text-dim">
            추가 프롬프트 (선택)
            <TextInput label="추가 프롬프트" value={prompt} onChange={setPrompt} placeholder="예: red hair, blue eyes" />
          </label>
          <SliderRow
            label="Defry — 높을수록 원본에서 덜 벗어납니다"
            value={defry}
            min={0}
            max={5}
            step={1}
            onChange={setDefry}
          />
        </div>
      )}
      {generating && <p className="mt-3 text-xs text-danger">대량 생성이 진행 중일 때는 실행할 수 없습니다.</p>}
    </Sheet>
  )
}
