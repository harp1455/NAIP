/**
 * 프로젝트 안내 — 단계 표시(새 프로젝트 → 축과 값 → 생성 → 선별 → 내보내기), "다음에 할 일" 카드,
 * 처음 보는 사람용 단계 설명. 무엇을 할지는 project/guide.ts가 정하고 여기서는 그리기만 한다.
 */
import type { ReactNode } from 'react'
import { Check, ChevronRight, FileDown, Layers, Loader2, Play, Settings2 } from 'lucide-react'
import { cx } from '../../lib/util'
import { GUIDE_STEPS, type NextAction, type ProjectGuide, type StepState } from '../../project'
import { Button } from '../ui'

const STEP_STATE_LABEL: Record<StepState, string> = { done: '끝남', now: '지금', doing: '남은 것 있음', todo: '아직' }

/**
 * 다섯 단계 막대 — 끝난 단계는 초록, 지금 단계는 주황, 지금 단계는 아니지만 남은 일이 있는 단계는 옅은 주황
 * (steps를 주지 않으면 step 앞은 끝남, 뒤는 아직)
 */
export function StepBar(props: { step: number; steps?: readonly StepState[]; className?: string }): ReactNode {
  return (
    <ol aria-label="진행 단계" className={cx('grid grid-cols-5 gap-1', props.className)}>
      {GUIDE_STEPS.map((name, i) => {
        const n = i + 1
        const state: StepState = props.steps?.[i] ?? (n < props.step ? 'done' : n === props.step ? 'now' : 'todo')
        return (
          <li key={name} aria-current={state === 'now' ? 'step' : undefined} className="min-w-0">
            <div
              className={cx(
                'h-1 rounded-full',
                state === 'done' ? 'bg-ok' : state === 'now' ? 'bg-accent' : state === 'doing' ? 'bg-accent/35' : 'bg-raised'
              )}
            />
            <div className={cx('mt-1 truncate text-center text-[10px]', state === 'now' ? 'font-semibold text-fg' : 'text-dim')}>
              {name}
              <span className="sr-only"> ({STEP_STATE_LABEL[state]})</span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export type GuideHandler = (a: NextAction) => void

/** 다음에 할 일 제목 · 한 줄 설명 */
function textOf(a: NextAction): { title: string; hint: string } {
  switch (a.kind) {
    case 'setup':
      return { title: '캐릭터와 축을 넣어 주세요', hint: '캐릭터 × 표정처럼 곱할 항목과 값을 넣으면 조합이 생깁니다' }
    case 'tooMany':
      return { title: '조합이 너무 많습니다', hint: '축 값을 줄이거나 꺼 주세요' }
    case 'generate':
      return { title: `조합 ${a.combos}개를 생성할 차례입니다`, hint: '생성 계획에서 장수와 예상 Anlas를 보고 시작합니다' }
    case 'running':
      return { title: `${a.images}장 생성 중`, hint: '다 만든 조합부터 바로 고를 수 있습니다' }
    case 'review':
      return { title: `고를 조합 ${a.combos}개`, hint: '한 장씩 크게 보며 채택·탈락을 고르고, 끝나면 다음 조합으로 넘어갑니다' }
    case 'missing':
      return { title: `그림이 모자란 조합 ${a.combos}개`, hint: '미생성·재생성 필요 조합만 채택 목표만큼 더 만듭니다' }
    case 'redo':
      return { title: `재생성 필요 조합 ${a.combos}개`, hint: '"재생성 필요"로 표시한 조합을 다시 만듭니다 (표시는 선별 화면에서 끕니다)' }
    case 'export':
      return { title: `내보낼 채택 그림 ${a.images}장`, hint: '정해 둔 이름·폴더로 갤러리나 ZIP에 저장합니다' }
    case 'done':
      return { title: '모두 끝났습니다', hint: '모든 조합을 채택하고 내보냈습니다. 바꿀 조합은 눌러서 다시 고를 수 있습니다' }
  }
}

/** 단추 글 (없으면 단추 없음) */
function actionLabel(a: NextAction): string | null {
  switch (a.kind) {
    case 'setup':
    case 'tooMany':
      return '설정으로'
    case 'generate':
      return '생성 계획'
    case 'review':
      return `선별하기 (${a.combos})`
    case 'missing':
      return `부족한 것만 생성 (${a.combos})`
    case 'redo':
      return `실패한 것만 생성 (${a.combos})`
    case 'export':
      return `내보내기 (${a.images}장)`
    default:
      return null
  }
}

function ActionIcon(props: { kind: NextAction['kind'] }): ReactNode {
  switch (props.kind) {
    case 'setup':
    case 'tooMany':
      return <Settings2 size={16} />
    case 'generate':
    case 'missing':
    case 'redo':
      return <Play size={16} />
    case 'review':
      return <Layers size={16} />
    case 'export':
      return <FileDown size={16} />
    default:
      return null
  }
}

/** 행렬 맨 위 "다음에 할 일" — 단계 막대, 지금 할 일 한 줄, 단추 (둘째 할 일은 작은 단추·한 줄) */
export function NextStepCard(props: { guide: ProjectGuide; onAction: GuideHandler; className?: string; children?: ReactNode }): ReactNode {
  const [first, second] = props.guide.actions
  const text = textOf(first)
  const label = actionLabel(first)
  const secondLabel = second ? actionLabel(second) : null
  return (
    <section aria-label="다음에 할 일" className={cx('rounded-xl border border-line bg-panel p-3', props.className)}>
      <StepBar step={props.guide.step} steps={props.guide.steps} />
      <div className="mt-3 flex items-start gap-2">
        <span className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', first.kind === 'done' ? 'bg-ok text-black' : 'bg-accent/15 text-accent')}>
          {first.kind === 'done' ? <Check size={13} strokeWidth={3} /> : first.kind === 'running' ? <Loader2 size={13} className="animate-spin" /> : <ChevronRight size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{text.title}</div>
          <p className="mt-0.5 text-xs text-dim">{text.hint}</p>
        </div>
      </div>
      {(label || secondLabel || second) && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {label && (
            <Button variant="primary" className="min-w-0 flex-1 px-3" onClick={() => props.onAction(first)}>
              <ActionIcon kind={first.kind} />
              {label}
            </Button>
          )}
          {second && secondLabel && (
            <Button variant="default" className={cx('px-3', !label && 'flex-1')} onClick={() => props.onAction(second)}>
              <ActionIcon kind={second.kind} />
              {secondLabel}
            </Button>
          )}
          {second && !secondLabel && second.kind === 'running' && (
            <span className="flex h-11 items-center gap-1.5 px-1 text-xs text-dim">
              <Loader2 size={14} className="animate-spin" />
              {second.images}장 생성 중
            </span>
          )}
        </div>
      )}
      {props.children && <div className="mt-3 border-t border-line pt-3">{props.children}</div>}
    </section>
  )
}

/** 처음 보는 사람용 단계 설명 (빈 프로젝트 목록) */
export function GuideIntro(): ReactNode {
  const steps: [string, string][] = [
    ['새 프로젝트', '이벤트·캐릭터 묶음마다 하나'],
    ['축과 값', '캐릭터 × 표정(웃음·울음 …) × 의상처럼 곱할 항목. 표정 기본 세트로 바로 시작할 수 있습니다'],
    ['생성', '조합마다 몇 장씩 — 예상 Anlas를 보고 한 번에'],
    ['선별', '조합마다 쓸 그림을 채택, 나머지는 탈락'],
    ['내보내기', '{캐릭터}_{표정}_01처럼 정해 둔 이름으로 갤러리·ZIP에']
  ]
  return (
    <ol className="mx-auto mt-4 flex max-w-sm flex-col gap-2 text-left">
      {steps.map(([name, hint], i) => (
        <li key={name} className="flex gap-2.5 rounded-lg border border-line bg-panel px-3 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised font-mono text-xs text-fg">{i + 1}</span>
          <span className="min-w-0">
            <span className="block text-sm text-fg">{name}</span>
            <span className="block text-xs text-dim">{hint}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

/** 설정 화면 맨 위 — 아직 그림이 없는 프로젝트에서 할 일 목록 (끝난 것은 체크) */
export function SetupChecklist(props: { characters: number; values: number; style: boolean; combos: number; onMatrix: () => void }): ReactNode {
  const rows: { done: boolean; title: string; hint: string }[] = [
    { done: props.characters > 0, title: '캐릭터 넣기', hint: '라이브러리에서 고르거나 직접 추가 (없어도 됨)' },
    { done: props.values > 0, title: '축과 값 넣기', hint: '표정 기본 세트를 누르면 웃음·울음 … 이 한 번에 들어갑니다' },
    { done: props.style, title: '화풍 프롬프트', hint: '모든 그림에 붙는 작가·화풍 태그 (선택)' }
  ]
  return (
    <section aria-label="처음 할 일" className="rounded-xl border border-line bg-panel p-3">
      <StepBar step={props.combos ? 3 : 2} />
      <ol className="mt-3 flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.title} className="flex items-start gap-2">
            <span
              className={cx(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                r.done ? 'border-ok bg-ok text-black' : 'border-line text-transparent'
              )}
            >
              <Check size={12} strokeWidth={3} />
            </span>
            <span className="min-w-0">
              <span className={cx('block text-sm', r.done && 'text-dim line-through')}>{r.title}</span>
              {!r.done && <span className="block text-xs text-dim">{r.hint}</span>}
            </span>
          </li>
        ))}
      </ol>
      <Button variant={props.combos ? 'primary' : 'default'} className="mt-3 w-full" disabled={!props.combos} onClick={props.onMatrix}>
        <Play size={16} />
        {props.combos ? `조합 ${props.combos}개 — 행렬에서 생성하기` : '조합이 생기면 행렬에서 생성합니다'}
      </Button>
    </section>
  )
}

/** "조합 10개 = 캐릭터 2 × 표정 5" 한 줄과 행렬로 가는 단추 */
export function MatrixSizeRow(props: { size: string; combos: number; tooMany: boolean; onMatrix: () => void }): ReactNode {
  if (!props.size) return null
  return (
    <button
      type="button"
      onClick={props.onMatrix}
      aria-label={`조합 ${props.combos}개, 행렬 보기`}
      className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-raised/60 px-3 py-2 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className={cx('block text-xs', props.tooMany ? 'text-danger' : 'text-fg')}>조합: {props.size}</span>
        <span className="block text-[11px] text-dim">값마다 그림이 따로 만들어집니다</span>
      </span>
      <span className="flex shrink-0 items-center text-xs text-accent">
        행렬 보기
        <ChevronRight size={14} />
      </span>
    </button>
  )
}
