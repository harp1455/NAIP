import { useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Sparkles, Wand2 } from 'lucide-react'
import {
  freePositions,
  GRID,
  MARKER_COLORS,
  mirrorPosition,
  positionFor,
  spreadPositions,
  type Center
} from '../lib/position'
import { cx } from '../lib/util'

export interface PositionedCharacter {
  key: number
  name: string
  /** null = AI가 정함 */
  center: Center | null
}

/**
 * 생성 해상도와 같은 비율의 배치 판. 마커를 끌어 위치를 정한다.
 * V5는 자유 위치(0.1%), V4/V4.5는 5×5 격자에 붙는다. 위치를 정하지 않은 캐릭터는 아래 칩에 남고(AI 선택)
 * 칩을 누르면 판에 올라온다.
 */
export function PositionCanvas(props: {
  characters: PositionedCharacter[]
  width: number
  height: number
  model: string
  onChange: (key: number, center: Center | null) => void
}): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ key: number; pointerId: number } | null>(null)
  const [active, setActive] = useState<number | null>(null)
  const free = freePositions(props.model)
  const placed = props.characters.filter((c) => c.center)
  const color = (key: number): string =>
    MARKER_COLORS[Math.max(0, props.characters.findIndex((c) => c.key === key)) % MARKER_COLORS.length]

  const moveTo = (key: number, clientX: number, clientY: number): void => {
    const r = box.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return
    props.onChange(key, positionFor({ x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }, props.model))
  }

  const setAll = (centers: (Center | null)[]): void =>
    props.characters.forEach((c, i) => props.onChange(c.key, centers[i] ?? null))

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-auto text-dim">
          {free ? 'V5: 자유 위치' : 'V4·V4.5: 5×5 격자'} · {placed.length}/{props.characters.length}명 지정
        </span>
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md border border-line px-2 active:bg-raised"
          onClick={() => setAll(spreadPositions(props.characters.length, props.model))}
        >
          <Wand2 size={13} />
          고르게
        </button>
        <button
          type="button"
          disabled={!placed.length}
          className="flex h-8 items-center gap-1 rounded-md border border-line px-2 active:bg-raised disabled:opacity-40"
          onClick={() => setAll(props.characters.map((c) => (c.center ? mirrorPosition(c.center, props.model) : null)))}
        >
          <ArrowLeftRight size={13} />
          좌우 반전
        </button>
        <button
          type="button"
          disabled={!placed.length}
          className="flex h-8 items-center gap-1 rounded-md border border-line px-2 active:bg-raised disabled:opacity-40"
          onClick={() => setAll([])}
        >
          <Sparkles size={13} />
          모두 AI
        </button>
      </div>
      <div
        ref={box}
        className="relative mx-auto touch-none overflow-hidden rounded-lg border border-line bg-field"
        // 가로·세로 한도 안에서 생성 해상도 비율을 그대로 지킨다
        style={{
          aspectRatio: `${props.width} / ${props.height}`,
          width: `min(100%, 320px, calc(46vh * ${props.width / Math.max(1, props.height)}))`
        }}
      >
        {/* 안내선: V5는 3등분, V4·V4.5는 놓을 수 있는 격자점 */}
        {free ? (
          <>
            {[1 / 3, 2 / 3].map((v) => (
              <div key={`v${v}`} className="absolute inset-y-0 w-px bg-white/10" style={{ left: `${v * 100}%` }} />
            ))}
            {[1 / 3, 2 / 3].map((v) => (
              <div key={`h${v}`} className="absolute inset-x-0 h-px bg-white/10" style={{ top: `${v * 100}%` }} />
            ))}
          </>
        ) : (
          GRID.map((y) =>
            GRID.map((x) => (
              <span
                key={`${x}-${y}`}
                className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/20"
                style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
              />
            ))
          )
        )}
        {placed.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-label={`${c.name} 위치 (가로 ${Math.round(c.center!.x * 1000) / 10}%, 세로 ${Math.round(c.center!.y * 1000) / 10}%)`}
            className={cx(
              'absolute flex h-9 min-w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white px-1.5 text-[11px] font-semibold text-black shadow-lg',
              active === c.key && 'scale-110'
            )}
            style={{ left: `${c.center!.x * 100}%`, top: `${c.center!.y * 100}%`, background: color(c.key) }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = { key: c.key, pointerId: e.pointerId }
              setActive(c.key)
            }}
            onPointerMove={(e) => {
              if (drag.current?.pointerId === e.pointerId) moveTo(c.key, e.clientX, e.clientY)
            }}
            onPointerUp={() => {
              drag.current = null
              setActive(null)
            }}
            onPointerCancel={() => {
              drag.current = null
              setActive(null)
            }}
          >
            <span className="max-w-16 truncate">{c.name}</span>
          </button>
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {props.characters.map((c, i) => (
          <li key={c.key}>
            <button
              type="button"
              aria-pressed={!!c.center}
              onClick={() =>
                props.onChange(c.key, c.center ? null : spreadPositions(props.characters.length, props.model)[i])
              }
              className={cx(
                'flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs',
                c.center ? 'border-line text-fg' : 'border-dashed border-line text-dim'
              )}
            >
              <span className="h-3 w-3 rounded-full" style={{ background: color(c.key) }} />
              {c.name}
              <span className="text-[10px] text-dim">{c.center ? '위치 지정' : 'AI 선택'}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-dim">
        위치는 2명 이상 출연할 때만 보냅니다. 대략적인 배치 힌트라 정확한 자세·겹침까지 보장하지는 않습니다.
      </p>
    </div>
  )
}
