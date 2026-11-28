import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import {
  addUserResolution,
  BUILTIN_RESOLUTIONS,
  exceedsFreeArea,
  FREE_PIXELS,
  RESOLUTION_NAME_MAX,
  sizeText,
  userResolutionText
} from '../nai/resolutionList'
import { fitNaiGenerationResolution, type ResolutionDimension } from '../nai/resolution'
import { cx } from '../lib/util'
import { useSettings } from '../stores/settings'
import { toast } from '../stores/toast'
import { Button, IconButton, Sheet, TextInput, Toggle } from './ui'

/** 무료 범위를 넘는 크기 표시 */
function AnlasMark(props: { width: number; height: number }): ReactNode {
  if (!exceedsFreeArea(props.width, props.height)) return null
  return <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">Anlas</span>
}

function SectionTitle(props: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <h3 className="text-xs font-semibold text-dim">{props.children}</h3>
      <div className="ml-auto flex items-center">{props.right}</div>
    </div>
  )
}

/** 새 해상도 넣기 — 64 배수·최대 크기에 맞춰 무엇이 더해질지 먼저 보여 준다 */
function AddForm(props: { prefill?: { width: number; height: number }; onAdded?: (size: { width: number; height: number }) => void }): ReactNode {
  const resolutions = useSettings((s) => s.resolutions)
  const hiddenResolutions = useSettings((s) => s.hiddenResolutions)
  const [name, setName] = useState('')
  const [w, setW] = useState(props.prefill ? String(props.prefill.width) : '')
  const [h, setH] = useState(props.prefill ? String(props.prefill.height) : '')
  const [edited, setEdited] = useState<ResolutionDimension>('height')
  const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 5)
  const fit = w && h ? fitNaiGenerationResolution(Number(w), Number(h), edited) : null
  const adjusted = !!fit && (fit.width !== Number(w) || fit.height !== Number(h))
  const check = fit ? addUserResolution({ resolutions, hiddenResolutions }, { name, ...fit }) : null
  const add = (): void => {
    if (!fit) return
    const r = useSettings.getState().addResolution({ name, ...fit })
    if (!r.ok) return toast(r.error, true)
    toast(r.notice ?? `${sizeText(fit.width, fit.height)}을(를) 목록에 더했습니다`)
    setName('')
    setW('')
    setH('')
    props.onAdded?.(fit)
  }
  let status: ReactNode
  if (!fit) status = <span className="text-dim">너비·높이는 64의 배수로 넣습니다 (다르면 가까운 크기로 맞춥니다)</span>
  else if (check && !check.ok) status = <span className="text-danger">{check.error}</span>
  else if (check?.ok && check.notice) status = <span className="text-fg">숨겨 둔 기본 해상도와 같은 크기입니다 — "추가"를 누르면 다시 보이게 합니다</span>
  else {
    const px = fit.width * fit.height
    status = (
      <>
        {adjusted && <span className="text-fg">64 배수로 맞춰 {sizeText(fit.width, fit.height)}로 더합니다. </span>}
        {exceedsFreeArea(fit.width, fit.height) ? (
          <span className="text-accent">
            {px.toLocaleString()}픽셀 — Opus 무료 범위(1024×1024)를 넘어 장마다 Anlas가 듭니다
          </span>
        ) : (
          <span className="text-dim">{px.toLocaleString()}픽셀 — Opus 무료 범위 안</span>
        )}
      </>
    )
  }
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      <h3 className="text-xs font-semibold text-dim">새 해상도</h3>
      <TextInput label="새 해상도 이름" placeholder={`이름 (선택, ${RESOLUTION_NAME_MAX}자까지)`} value={name} onChange={setName} />
      <div className="flex items-center gap-1.5">
        <TextInput
          label="새 해상도 너비"
          inputMode="numeric"
          placeholder="너비"
          className="!w-[76px] text-center font-mono"
          value={w}
          onChange={(v) => {
            setW(digits(v))
            setEdited('width')
          }}
        />
        <span className="text-dim">×</span>
        <TextInput
          label="새 해상도 높이"
          inputMode="numeric"
          placeholder="높이"
          className="!w-[76px] text-center font-mono"
          value={h}
          onChange={(v) => {
            setH(digits(v))
            setEdited('height')
          }}
        />
        <IconButton
          label="가로·세로 바꾸기"
          className="h-11 w-11"
          disabled={!w && !h}
          onClick={() => {
            setW(h)
            setH(w)
            setEdited(edited === 'width' ? 'height' : 'width')
          }}
        >
          <ArrowLeftRight size={16} />
        </IconButton>
        <Button variant="primary" className="ml-auto" disabled={!fit || (!!check && !check.ok)} onClick={add}>
          추가
        </Button>
      </div>
      <p className="text-xs leading-relaxed" role="status">
        {status}
      </p>
    </section>
  )
}

/**
 * 해상도 목록 편집 — 내 해상도 더하기·지우기·순서 바꾸기, 기본 해상도 숨기기·다시 보이기.
 * 바꾸면 바로 저장된다. 지금 쓰는 크기는 바꾸지 않는다 (목록에서 빠지면 "사용자 지정"으로 보인다).
 * 다른 시트 안에서 열려도 겹치지 않게 body 에 띄운다
 */
export function ResolutionListSheet(props: {
  onClose: () => void
  /** 이 크기를 새 해상도 칸에 미리 넣어 둔다 ("목록에 추가") */
  prefill?: { width: number; height: number }
  onAdded?: (size: { width: number; height: number }) => void
}): ReactNode {
  const s = useSettings()
  const hidden = new Set(s.hiddenResolutions)
  const fail = (r: { ok: boolean; error?: string }): void => {
    if (!r.ok && r.error) toast(r.error, true)
  }
  return createPortal(
    <Sheet title="해상도 목록 편집" onClose={props.onClose}>
      <div className="flex flex-col gap-4">
        <AddForm prefill={props.prefill} onAdded={props.onAdded} />

        <section>
          <SectionTitle right={<span className="text-xs text-dim">{s.resolutions.length}개</span>}>내 해상도</SectionTitle>
          {s.resolutions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-dim">
              아직 없습니다. 위에서 크기를 넣고 "추가"를 누르세요.
            </p>
          ) : (
            <ul aria-label="내 해상도" className="flex flex-col divide-y divide-line rounded-lg border border-line">
              {s.resolutions.map((r, i) => {
                const text = userResolutionText(r)
                return (
                  <li key={`${r.width}x${r.height}`} className="flex min-h-12 items-center gap-1 pl-3 pr-1">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{r.name ?? sizeText(r.width, r.height)}</div>
                      {r.name && <div className="font-mono text-xs text-dim">{sizeText(r.width, r.height)}</div>}
                    </div>
                    <AnlasMark width={r.width} height={r.height} />
                    <IconButton label={`${text} 위로`} disabled={i === 0} onClick={() => fail(s.moveResolution(i, -1))}>
                      <ChevronUp size={18} />
                    </IconButton>
                    <IconButton
                      label={`${text} 아래로`}
                      disabled={i === s.resolutions.length - 1}
                      onClick={() => fail(s.moveResolution(i, 1))}
                    >
                      <ChevronDown size={18} />
                    </IconButton>
                    <IconButton
                      label={`${text} 지우기`}
                      className="hover:text-danger"
                      onClick={() => {
                        if (!window.confirm(`"${text}"을(를) 목록에서 지울까요? 이 크기를 쓰고 있는 설정은 그대로 둡니다.`)) return
                        fail(s.removeResolution(i))
                      }}
                    >
                      <Trash2 size={17} />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <SectionTitle
            right={
              hidden.size > 0 && (
                <Button
                  variant="ghost"
                  className="h-8 px-2 text-xs"
                  onClick={() => {
                    for (const key of s.hiddenResolutions) s.setResolutionHidden(key, false)
                  }}
                >
                  모두 보이기
                </Button>
              )
            }
          >
            기본 해상도 · {BUILTIN_RESOLUTIONS.length - hidden.size}/{BUILTIN_RESOLUTIONS.length}개 보임
          </SectionTitle>
          <ul aria-label="기본 해상도" className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {BUILTIN_RESOLUTIONS.map((r) => {
              const shown = !hidden.has(r.key)
              return (
                <li key={r.key} className="flex min-h-12 items-center gap-2 px-3">
                  <div className={cx('min-w-0 flex-1', !shown && 'opacity-50')}>
                    <span className="text-sm">{r.name}</span>{' '}
                    <span className="font-mono text-xs text-dim">{sizeText(r.width, r.height)}</span>
                  </div>
                  <AnlasMark width={r.width} height={r.height} />
                  <Toggle label={`${r.name} 보이기`} checked={shown} onChange={(on) => fail(s.setResolutionHidden(r.key, !on))} />
                </li>
              )
            })}
          </ul>
          <p className="mt-1.5 text-xs text-dim">끈 크기는 해상도 고르는 칸에서 숨깁니다. 언제든 다시 켤 수 있습니다.</p>
        </section>

        <p className="pb-2 text-xs leading-relaxed text-dim">
          <span className="rounded bg-accent/15 px-1 font-medium text-accent">Anlas</span> 표시는 Opus 무료 생성 범위(1024×1024 ={' '}
          {FREE_PIXELS.toLocaleString()}픽셀)를 넘는 크기입니다. 목록을 바꿔도 지금 쓰고 있는 해상도는 바뀌지 않습니다.
        </p>
      </div>
    </Sheet>,
    document.body
  )
}
