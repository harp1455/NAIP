import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Brush, Eraser, PaintBucket, Trash2, Undo2 } from 'lucide-react'
import { loadImage, pngDataUrl } from '../lib/image'
import { Button, IconButton, Sheet } from './ui'

/** 칠한 색 — 내보낼 때는 "칠해진 곳 = 재생성 영역"만 의미가 있다 (R 채널로 이진화) */
const PAINT = '#e8914f'
const MAX_UNDO = 8

export function MaskEditor(props: {
  image: string
  width: number
  height: number
  mask: string | null
  onSave: (mask: string | null) => void
  onClose: () => void
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const undo = useRef<ImageData[]>([])
  const drawing = useRef<{ x: number; y: number } | null>(null)
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [size, setSize] = useState(Math.round(Math.max(props.width, props.height) / 14))
  const [canUndo, setCanUndo] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ w: 0, h: 0 })

  // 스테이지 안에 이미지 비율을 유지한 채 꽉 차게 (contain)
  useEffect(() => {
    const el = stageRef.current!
    const measure = (): void => {
      const scale = Math.min(el.clientWidth / props.width, el.clientHeight / props.height)
      setFit({ w: Math.floor(props.width * scale), h: Math.floor(props.height * scale) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [props.width, props.height])

  useEffect(() => {
    const ctx = canvasRef.current!.getContext('2d')!
    if (props.mask) void loadImage(props.mask).then((img) => ctx.drawImage(img, 0, 0, props.width, props.height))
  }, [props.mask, props.width, props.height])

  const ctxOf = (): CanvasRenderingContext2D => canvasRef.current!.getContext('2d')!
  const snapshot = (): void => {
    undo.current.push(ctxOf().getImageData(0, 0, props.width, props.height))
    if (undo.current.length > MAX_UNDO) undo.current.shift()
    setCanUndo(true)
  }
  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * props.width,
      y: ((e.clientY - r.top) / r.height) * props.height
    }
  }
  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }): void => {
    const ctx = ctxOf()
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = PAINT
    ctx.lineWidth = size
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.globalCompositeOperation = 'source-over'
  }
  const fill = (clear: boolean): void => {
    snapshot()
    const ctx = ctxOf()
    ctx.clearRect(0, 0, props.width, props.height)
    if (!clear) {
      ctx.fillStyle = PAINT
      ctx.fillRect(0, 0, props.width, props.height)
    }
  }
  const save = (): void => {
    const data = ctxOf().getImageData(0, 0, props.width, props.height).data
    let any = false
    for (let i = 3; i < data.length; i += 4 * 16) {
      if (data[i] > 0) {
        any = true
        break
      }
    }
    props.onSave(any ? canvasRef.current!.toDataURL('image/png') : null)
    props.onClose()
  }

  return (
    <Sheet
      title="인페인트 마스크"
      onClose={props.onClose}
      flush
      footer={
        <>
          <Button onClick={props.onClose}>취소</Button>
          <Button variant="primary" className="flex-1" onClick={save}>
            마스크 적용
          </Button>
        </>
      }
    >
      <div className="flex h-full flex-col">
        <div ref={stageRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
          <div className="relative shrink-0" style={{ width: fit.w, height: fit.h }}>
            <img
              src={pngDataUrl(props.image)}
              alt="인페인트 원본"
              draggable={false}
              className="absolute inset-0 h-full w-full"
            />
            <canvas
              ref={canvasRef}
              width={props.width}
              height={props.height}
              className="absolute inset-0 h-full w-full touch-none opacity-60"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                snapshot()
                const p = point(e)
                drawing.current = p
                stroke(p, p)
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return
                const p = point(e)
                stroke(drawing.current, p)
                drawing.current = p
              }}
              onPointerUp={() => (drawing.current = null)}
              onPointerCancel={() => (drawing.current = null)}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-1.5">
          <IconButton label="브러시" active={tool === 'brush'} onClick={() => setTool('brush')}>
            <Brush size={18} />
          </IconButton>
          <IconButton label="지우개" active={tool === 'eraser'} onClick={() => setTool('eraser')}>
            <Eraser size={18} />
          </IconButton>
          <input
            type="range"
            aria-label="브러시 크기"
            className="mx-2 h-8 min-w-0 flex-1"
            min={8}
            max={Math.round(Math.max(props.width, props.height) / 3)}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
          <IconButton
            label="되돌리기"
            disabled={!canUndo}
            onClick={() => {
              const prev = undo.current.pop()
              if (prev) ctxOf().putImageData(prev, 0, 0)
              setCanUndo(undo.current.length > 0)
            }}
          >
            <Undo2 size={18} />
          </IconButton>
          <IconButton label="전체 칠하기" onClick={() => fill(false)}>
            <PaintBucket size={18} />
          </IconButton>
          <IconButton label="전체 지우기" onClick={() => fill(true)}>
            <Trash2 size={18} />
          </IconButton>
        </div>
      </div>
    </Sheet>
  )
}
