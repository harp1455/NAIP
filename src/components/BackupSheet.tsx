/**
 * 설정 → 백업·복원 (Phase 4). SettingsPane 이 React.lazy 로 열어서, 이 화면과 src/backup 은 첫 화면 번들에 들어가지 않는다.
 *
 * - 백업 만들기: 가벼운 백업 / 전체 백업 / 직접 고르기 → 예상 크기·남은 공간 → 저장할 곳 고르기 → 진행·취소 → 결과
 * - 복원: 파일 고르기 → 종류 판별·체크섬 확인 → 미리보기(섹션별 개수·충돌·손상) → 방식 고르기 → 확인(무엇이 바뀌는지)
 *         → 자동 백업 → 적용 → 결과(넣은 것·건너뛴 것·손상된 것·되돌리기)
 * - NAIS3로 내보내기: 잃는 것을 먼저 보여 준 뒤 .nais 쓰기
 * - 복원 전 자동 백업 목록: 되돌리기·파일로 저장·지우기
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArchiveRestore, Check, FileDown, FolderOpen, History, Lock, RotateCcw, Trash2 } from 'lucide-react'
import {
  applyRestore,
  createBackupFile,
  estimateBackup,
  exportSafety,
  isDestructive,
  listSafety,
  nais3Plan,
  openRestoreSource,
  pickRestoreFile,
  planFor,
  previewFor,
  removeSafety,
  safetyFile,
  writeNais3File,
  type BackupEstimate,
  type HistoryChoice,
  type RestoreChoice,
  type RestorePhase,
  type RestoreSource,
  type RestoreSummary
} from '../backup/app'
import {
  BackupError,
  DATA_SECTION_IDS,
  MODE_SECTIONS,
  SECTION_LABELS,
  DEFAULT_NAIS3_EXPORT,
  type BackupData,
  type BackupMode,
  type DataSectionId,
  type EntryProblem,
  type Nais3ExportPlan,
  type Nais3ExportSection,
  type ProgressInfo,
  type RestoreMode,
  type RestorePlan,
  type SafetyBackup,
  type SectionAction,
  type SectionId,
  type SectionPreview,
  type WriteBackupResult
} from '../backup'
import { cx } from '../lib/util'
import { formatBytes, freeSpace } from '../storage'
import { useGeneration } from '../stores/generation'
import { toast } from '../stores/toast'
import { Segmented } from './SlotEditor'
import { Button, IconButton, Row, Select, Sheet, Toggle } from './ui'

/** 이 앱에 아직 스토어가 없는 섹션 — 고르기 화면에 내놓지 않는다 */
const HIDDEN: readonly SectionId[] = ['collections', 'exportTemplates']

const LABEL: Record<SectionId, string> = { ...SECTION_LABELS, history: '히스토리 기록(썸네일)', historyOriginals: '원본 이미지' }

const PICKABLE: SectionId[] = [...DATA_SECTION_IDS.filter((id) => !HIDDEN.includes(id)), 'history', 'historyOriginals']

/** 항목 수가 아니라 값 묶음인 섹션 (개수 대신 "바꿈/유지"로 말한다) */
const ITEMLESS: readonly SectionId[] = ['settings', 'prompt']

const KIND_LABEL: Record<RestoreSource['kind'], string> = {
  naip: 'NAIP 백업 (.naipbackup)',
  nais3: 'NAIS3 백업 (.nais)',
  'naip-json': '예전 NAIP JSON 백업',
  'nais3-json': 'NAIS3 JSON 백업'
}

const PHASE_LABEL: Record<ProgressInfo['phase'], string> = {
  sections: '설정·라이브러리',
  history: '히스토리 기록',
  originals: '원본 그림',
  finish: '마무리',
  verify: '체크섬 확인',
  restore: '히스토리 넣기'
}

const RESTORE_PHASE: Record<RestorePhase, string> = {
  safety: '지금 상태를 자동 백업하는 중…',
  sections: '데이터를 넣는 중…',
  history: '히스토리를 넣는 중…',
  finish: '마무리하는 중…'
}

type Step =
  | { name: 'home' }
  | { name: 'writing'; fileName: string | null; progress: ProgressInfo | null }
  | { name: 'written'; fileName: string; result: WriteBackupResult }
  | { name: 'failed'; title: string; message: string }
  | { name: 'opening'; fileName: string; progress: ProgressInfo | null }
  | { name: 'preview'; src: RestoreSource; preview: SectionPreview[]; free: number | null; initial: RestoreChoice & { safety: boolean } }
  | { name: 'confirm'; src: RestoreSource; plan: RestorePlan; choice: RestoreChoice; safety: boolean; preview: SectionPreview[]; free: number | null }
  | { name: 'applying'; phase: RestorePhase; progress: ProgressInfo | null }
  | { name: 'restored'; summary: RestoreSummary }
  | { name: 'nais3'; data: BackupData; plan: Nais3ExportPlan; withRefs: boolean }
  | { name: 'nais3-writing' }
  | { name: 'nais3-done'; fileName: string; bytes: number }

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isAbort(e: unknown): boolean {
  return e instanceof BackupError && e.code === 'aborted'
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
}

function Group(props: { title: ReactNode; children: ReactNode; testId?: string }): ReactNode {
  return (
    <section className="rounded-xl border border-line bg-panel px-3 py-2" data-testid={props.testId}>
      <h3 className="py-1 text-xs font-semibold text-dim">{props.title}</h3>
      {props.children}
    </section>
  )
}

function Note(props: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; testId?: string }): ReactNode {
  const tone = props.tone ?? 'info'
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      data-testid={props.testId}
      className={cx(
        'rounded-lg px-2.5 py-2 text-xs leading-relaxed',
        tone === 'info' && 'bg-field text-dim',
        tone === 'warn' && 'bg-accent/10 text-fg',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'ok' && 'bg-ok/10 text-ok'
      )}
    >
      {props.children}
    </div>
  )
}

function Progress(props: { progress: ProgressInfo | null; label?: string }): ReactNode {
  const p = props.progress
  const ratio = p && p.total ? Math.min(1, p.done / p.total) : null
  return (
    <div className="flex flex-col gap-1.5" data-testid="progress">
      <div className="h-2 overflow-hidden rounded-full bg-raised">
        <div
          className={cx('h-full rounded-full bg-accent transition-[width]', ratio === null && 'w-1/3 animate-pulse')}
          style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      <p className="text-xs tabular-nums text-dim">
        {props.label ?? (p ? PHASE_LABEL[p.phase] : '준비하는 중…')}
        {p ? ` · ${p.done.toLocaleString()}${p.total !== null ? ` / ${p.total.toLocaleString()}` : ''}개 · ${formatBytes(p.bytes)}` : ''}
      </p>
      {p?.current && <p className="truncate font-mono text-[11px] text-dim">{p.current}</p>}
    </div>
  )
}

function ProblemList(props: { problems: EntryProblem[]; max?: number }): ReactNode {
  const max = props.max ?? 20
  return (
    <ul className="mt-1 flex flex-col gap-0.5 break-all">
      {props.problems.slice(0, max).map((p, i) => (
        <li key={`${p.path}-${i}`}>
          <span className="font-mono">{p.path}</span> — {p.detail}
        </li>
      ))}
      {props.problems.length > max && <li>… 외 {props.problems.length - max}개</li>}
    </ul>
  )
}

/** 고르는 줄 (체크박스) — 줄 전체를 눌러도 된다 */
function CheckRow(props: { label: ReactNode; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }): ReactNode {
  return (
    <label className={cx('flex min-h-11 items-center gap-3 py-1', props.disabled && 'opacity-45')}>
      <input
        type="checkbox"
        className="h-5 w-5 shrink-0 accent-[var(--color-accent)]"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{props.label}</span>
        {props.hint && <span className="block text-xs text-dim">{props.hint}</span>}
      </span>
    </label>
  )
}

/** 세 가지 중 하나 (큰 카드형 라디오) */
function ModeCard(props: { checked: boolean; title: string; hint: ReactNode; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      onClick={props.onClick}
      className={cx(
        'flex min-h-14 w-full flex-col items-start rounded-lg border px-3 py-2 text-left',
        props.checked ? 'border-accent bg-accent/10' : 'border-line bg-field'
      )}
    >
      <span className={cx('text-sm font-medium', props.checked ? 'text-accent' : 'text-fg')}>{props.title}</span>
      <span className="mt-0.5 text-xs text-dim">{props.hint}</span>
    </button>
  )
}

const LIGHT_LIST = MODE_SECTIONS.light.filter((id) => !HIDDEN.includes(id)).map((id) => LABEL[id])

// ── 백업 만들기 (홈 화면의 한 구역) ─────────────────────────────────────

function CreateGroup(props: { busy: boolean; onCreate: (mode: BackupMode, sections: SectionId[]) => void }): ReactNode {
  const [mode, setMode] = useState<BackupMode>('light')
  const [picked, setPicked] = useState<Set<SectionId>>(() => new Set(MODE_SECTIONS.light.filter((id) => !HIDDEN.includes(id))))
  const [est, setEst] = useState<BackupEstimate | null>(null)
  // 섹션별 개수는 고르기와 상관없으니 다시 어림하는 동안에도 남겨 둔다
  const [counts, setCounts] = useState<BackupEstimate['counts']>({})
  const sections = [...picked]
  const key = `${mode}:${sections.sort().join(',')}`
  useEffect(() => {
    let live = true
    setEst(null)
    const t = setTimeout(() => {
      estimateBackup({ mode, sections })
        .then((e) => {
          if (!live) return
          setEst(e)
          setCounts(e.counts)
        })
        .catch(() => live && setEst(null))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: SectionId, on: boolean): void => {
    const next = new Set(picked)
    if (on) next.add(id)
    else next.delete(id)
    // 원본은 기록 없이 담을 수 없다
    if (id === 'historyOriginals' && on) next.add('history')
    if (id === 'history' && !on) next.delete('historyOriginals')
    setPicked(next)
  }
  const tooBig = est && est.free !== null && est.estimate.bytes > est.free
  const empty = mode === 'custom' && !picked.size
  const n = est?.historyCount

  return (
    <Group title="백업 만들기" testId="backup-create">
      <div role="radiogroup" aria-label="백업 종류" className="flex flex-col gap-1.5 pb-2">
        <ModeCard checked={mode === 'light'} title="가벼운 백업" hint={`${LIGHT_LIST.join('·')} — 히스토리 제외`} onClick={() => setMode('light')} />
        <ModeCard
          checked={mode === 'full'}
          title="전체 백업"
          hint={`가벼운 백업 + 히스토리 기록과 원본 이미지${n !== undefined ? ` ${n.toLocaleString()}장` : ''}`}
          onClick={() => setMode('full')}
        />
        <ModeCard checked={mode === 'custom'} title="직접 고르기" hint="담을 항목을 하나씩 고릅니다" onClick={() => setMode('custom')} />
      </div>
      {mode === 'custom' && (
        <div className="mb-2 rounded-lg border border-line bg-field px-3 py-1" data-testid="backup-sections">
          {PICKABLE.map((id) => (
            <CheckRow
              key={id}
              label={LABEL[id]}
              hint={
                id === 'historyOriginals'
                  ? '원본은 기록과 함께만 담깁니다'
                  : counts[id] !== undefined && !ITEMLESS.includes(id)
                    ? `${counts[id]!.toLocaleString()}${id === 'history' ? '장' : '개'}`
                    : undefined
              }
              checked={picked.has(id)}
              onChange={(v) => toggle(id, v)}
            />
          ))}
        </div>
      )}
      <p className="pb-2 text-xs text-dim" data-testid="backup-estimate">
        {est
          ? `예상 크기 최대 약 ${formatBytes(est.estimate.bytes)}${est.free !== null ? ` · 기기 남은 공간 ${formatBytes(est.free)}` : ''}`
          : '크기를 어림하는 중…'}
      </p>
      {tooBig && (
        <div className="pb-2">
          <Note tone="danger">예상 크기가 기기 남은 공간보다 큽니다. 다른 저장소(SD 카드·클라우드)를 고르거나 원본 이미지를 빼세요.</Note>
        </div>
      )}
      <Button variant="primary" className="w-full" disabled={props.busy || empty} onClick={() => props.onCreate(mode, sections)}>
        <FileDown size={18} />
        백업 파일 만들기
      </Button>
      <p className="py-2 text-xs leading-relaxed text-dim">
        저장할 곳을 고르는 창이 뜹니다. 생성 대기열은 담지 않습니다 (복원하면서 유료 생성이 다시 돌지 않도록).
      </p>
    </Group>
  )
}

// ── 복원 미리보기 ───────────────────────────────────────────────────────

function sectionLine(p: SectionPreview, action: SectionAction): string {
  if (action === 'skip') return '건너뜀'
  const itemless = ITEMLESS.includes(p.section)
  if (action === 'overwrite') {
    if (itemless) return '백업 값으로 바꿈'
    return `지금 ${p.current}개 → 백업 ${p.incoming}개${p.removedOnOverwrite ? ` (사라지는 것 ${p.removedOnOverwrite}개)` : ''}`
  }
  if (p.mergePolicy === 'none') return '합칠 수 없어 지금 것을 유지'
  if (itemless) return '지금 값을 유지하고 없는 값만 더함'
  const adds = p.incoming - p.identical - (p.mergePolicy === 'keep-current' ? p.idConflicts : 0)
  const parts = [`더할 것 ${Math.max(0, adds)}개`]
  if (p.identical) parts.push(`같은 것 ${p.identical}개`)
  if (p.idConflicts) parts.push(p.mergePolicy === 'keep-current' ? `같은 id ${p.idConflicts}개는 지금 것 유지` : `id 충돌 ${p.idConflicts}개는 새 id로`)
  if (p.nameConflicts) parts.push(`이름 바뀜 ${p.nameConflicts}개`)
  return parts.join(' · ')
}

function PreviewView(props: {
  src: RestoreSource
  preview: SectionPreview[]
  free: number | null
  busy: boolean
  initial: RestoreChoice & { safety: boolean }
  onNext: (choice: RestoreChoice, safety: boolean) => void
}): ReactNode {
  const { src, preview } = props
  const [mode, setMode] = useState<RestoreMode>(props.initial.mode)
  const [sections, setSections] = useState<Partial<Record<DataSectionId, SectionAction>>>(() => ({
    ...Object.fromEntries(preview.map((p) => [p.section, 'merge'])),
    ...props.initial.sections
  }))
  const h = src.history
  const [history, setHistory] = useState<HistoryChoice>(
    h && src.reader && !(h.damaged && props.initial.history === 'replace') ? props.initial.history : 'skip'
  )
  const [originals, setOriginals] = useState(props.initial.originals)
  const [safety, setSafety] = useState(props.initial.safety)
  const actionOf = (id: DataSectionId): SectionAction => (mode === 'selective' ? (sections[id] ?? 'skip') : mode)
  const needSpace = h && history !== 'skip' && originals ? h.originalBytes : 0
  const lowSpace = props.free !== null && needSpace > props.free
  // 백업에도 지금에도 항목이 없는 섹션은 바뀌는 것이 없어 보여 주지 않는다
  const shown = preview.filter((p) => ITEMLESS.includes(p.section) || p.incoming > 0 || p.current > 0)
  const nothing = !shown.some((p) => actionOf(p.section) !== 'skip') && history === 'skip'

  return (
    <div className="flex flex-col gap-3" data-testid="restore-preview">
      <Group title="열린 파일">
        <p className="text-sm break-all">{src.fileName}</p>
        <p className="pb-1 text-xs text-dim">
          {KIND_LABEL[src.kind]}
          {src.manifest ? ` · ${when(src.manifest.createdAt)} · NAIP ${src.manifest.appVersion}` : ''}
        </p>
        {src.kind === 'naip' &&
          (src.problems.length ? (
            <Note tone="danger" testId="integrity-problems">
              <p className="font-medium">파일 문제 {src.problems.length}개 — 손상된 항목은 건너뜁니다</p>
              {src.damaged.length > 0 && <p>복원할 수 없는 항목: {src.damaged.map((id) => LABEL[id]).join(', ')}</p>}
              {h?.damaged && <p>히스토리에 손상된 부분이 있어 "바꾸기"는 할 수 없습니다 (합치기만)</p>}
              <ProblemList problems={src.problems} />
            </Note>
          ) : (
            <Note tone="ok" testId="integrity-ok">
              모든 항목의 체크섬이 맞습니다
            </Note>
          ))}
        {src.unknownSections.length > 0 && (
          <div className="pt-1.5">
            <Note>이 앱이 모르는 항목은 건너뜁니다: {src.unknownSections.join(', ')}</Note>
          </div>
        )}
        {src.report && (
          <div className="pt-1.5" data-testid="nais3-report">
            <Note tone="warn">
              <p className="pb-1 font-medium">NAIS3 변환 보고서</p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-sans">{src.report.join('\n') || '모두 그대로 옮깁니다'}</pre>
            </Note>
          </div>
        )}
        {(src.kind === 'naip-json' || src.kind === 'nais3-json') && (
          <p className="pt-1 text-xs text-dim">예전 형식의 캐릭터(프롬프트 한 칸·출연 목록)는 지금 형식(고정·가변·디테일·출연 슬롯)으로 옮깁니다.</p>
        )}
      </Group>

      <Group title="복원 방식">
        <Segmented
          label="복원 방식"
          value={mode}
          options={[
            { value: 'merge', label: '합치기' },
            { value: 'overwrite', label: '덮어쓰기' },
            { value: 'selective', label: '골라서' }
          ]}
          onChange={setMode}
        />
        <p className="py-1.5 text-xs leading-relaxed text-dim">
          {mode === 'merge'
            ? '지금 데이터는 그대로 두고 백업 항목을 더합니다. 같은 id 에 내용이 다르면 새 id 로, 같은 이름은 "이름 (2)" 로 더합니다.'
            : mode === 'overwrite'
              ? '백업에 든 항목마다 지금 데이터를 백업 내용으로 바꿉니다. 백업에 없는 지금 항목은 사라집니다.'
              : '항목마다 덮어쓰기·합치기·건너뛰기를 고릅니다.'}
        </p>
        <ul className="flex flex-col" data-testid="restore-sections">
          {shown.map((p) => (
            <li key={p.section} className="flex min-h-12 items-center gap-2 border-t border-line py-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{p.label}</div>
                <div className="text-xs text-dim">
                  {ITEMLESS.includes(p.section) ? '' : `백업 ${p.incoming}개 · 지금 ${p.current}개 · `}
                  {sectionLine(p, actionOf(p.section))}
                </div>
              </div>
              {mode === 'selective' && (
                <Select
                  label={`${p.label} 복원 방식`}
                  className="w-28"
                  value={sections[p.section] ?? 'skip'}
                  options={[
                    { value: 'merge', label: '합치기' },
                    { value: 'overwrite', label: '덮어쓰기' },
                    { value: 'skip', label: '건너뛰기' }
                  ]}
                  onChange={(v: SectionAction) => setSections({ ...sections, [p.section]: v })}
                />
              )}
            </li>
          ))}
          {!shown.length && <li className="py-2 text-xs text-dim">복원할 데이터 항목이 없습니다</li>}
        </ul>
      </Group>

      {h && (
        <Group title="히스토리" testId="restore-history">
          <p className="pb-1.5 text-xs text-dim">
            기록 {h.records.toLocaleString()}장{h.originals ? ` · 원본 ${h.originals.toLocaleString()}장 (${formatBytes(h.originalBytes)})` : ' · 원본 없음 (썸네일만)'}
          </p>
          <Segmented
            label="히스토리 복원"
            value={history}
            options={[
              { value: 'skip', label: '건너뛰기' },
              { value: 'merge', label: '합치기' },
              ...(h.damaged ? [] : [{ value: 'replace' as const, label: '바꾸기' }])
            ]}
            onChange={setHistory}
          />
          <p className="py-1.5 text-xs leading-relaxed text-dim">
            {history === 'merge'
              ? '지금 없는 그림만 더합니다 (같은 id 는 같은 그림으로 보고 건너뜁니다).'
              : history === 'replace'
                ? '백업 그림을 모두 넣은 뒤, 하나도 실패하지 않았을 때만 백업에 없는 지금 그림을 지웁니다.'
                : '히스토리는 그대로 둡니다.'}
          </p>
          {h.originals > 0 && history !== 'skip' && (
            <Row label="원본 이미지도 넣기" hint="끄면 기록과 썸네일만 넣습니다">
              <Toggle label="원본 이미지도 넣기" checked={originals} onChange={setOriginals} />
            </Row>
          )}
          {needSpace > 0 && (
            <p className={cx('pb-1 text-xs', lowSpace ? 'text-danger' : 'text-dim')}>
              필요한 공간 약 {formatBytes(needSpace)}
              {props.free !== null ? ` · 기기 남은 공간 ${formatBytes(props.free)}` : ''}
              {lowSpace ? ' — 공간이 모자랍니다' : ''}
            </p>
          )}
        </Group>
      )}

      <Group title="안전">
        <Row label="복원 전에 지금 상태 자동 백업" hint="히스토리를 뺀 지금 데이터를 앱 안에 남겨, 복원 뒤에도 이 화면에서 되돌릴 수 있습니다 (최근 3개)">
          <Toggle label="복원 전에 지금 상태 자동 백업" checked={safety} onChange={setSafety} />
        </Row>
        {!safety && <Note tone="danger">자동 백업을 끄면 덮어쓴 내용을 되돌릴 수 없습니다.</Note>}
      </Group>

      <Button
        variant="primary"
        className="w-full"
        disabled={props.busy || nothing}
        onClick={() => props.onNext({ mode, sections, history, originals }, safety)}
      >
        다음 — 바뀌는 것 확인
      </Button>
    </div>
  )
}

// ── 확인 화면 ───────────────────────────────────────────────────────────

function ConfirmView(props: { src: RestoreSource; plan: RestorePlan; safety: boolean }): ReactNode {
  const { src, plan } = props
  const destructive = isDestructive(plan)
  // 백업에도 지금에도 항목이 없어 바뀌는 것이 없는 섹션은 줄이지 않고 뺀다
  const planned = DATA_SECTION_IDS.filter((id) => {
    const s = plan.sections[id]
    return s && (ITEMLESS.includes(id) || s.stats.incoming > 0 || s.stats.current > 0)
  })
  const skipped = DATA_SECTION_IDS.filter((id) => !plan.sections[id] && src.data[id] != null)
  return (
    <div className="flex flex-col gap-3" data-testid="restore-confirm">
      <Group title="이렇게 복원합니다">
        <ul className="flex flex-col gap-1.5 pb-1 text-sm">
          {planned.map((id) => {
            const s = plan.sections[id]!
            const removed = s.changes.filter((c) => c.kind === 'removed')
            return (
              <li key={id} className="leading-snug">
                <span className={cx('mr-1.5 rounded px-1.5 py-0.5 text-[11px]', s.action === 'overwrite' ? 'bg-danger/15 text-danger' : 'bg-raised text-dim')}>
                  {s.action === 'overwrite' ? '덮어씀' : '합침'}
                </span>
                {LABEL[id]}:{' '}
                {ITEMLESS.includes(id)
                  ? s.action === 'overwrite'
                    ? '지금 값을 백업 값으로 바꿉니다'
                    : '지금 값을 유지하고 지금 없는 값만 더합니다'
                  : s.action === 'overwrite'
                    ? `지금 ${s.stats.current}개 → 백업 ${s.stats.incoming}개${s.stats.replaced ? `, 내용이 바뀌는 것 ${s.stats.replaced}개` : ''}`
                    : `${s.stats.added}개 더함${s.stats.reassigned ? ` (새 id ${s.stats.reassigned}개)` : ''}${s.stats.renamed ? `, 이름 바뀜 ${s.stats.renamed}개` : ''}${s.stats.identical ? `, 같은 것 ${s.stats.identical}개` : ''}${s.stats.kept ? `, 같은 id 라 지금 것 유지 ${s.stats.kept}개` : ''}`}
                {removed.length > 0 && (
                  <span className="block text-xs text-danger">
                    사라지는 것 {removed.length}개: {removed.slice(0, 8).map((c) => c.name ?? `#${String(c.id)}`).join(', ')}
                    {removed.length > 8 ? ' …' : ''}
                  </span>
                )}
                {s.stats.dangling > 0 && <span className="block text-xs text-dim">없는 대상을 가리키던 연결 {s.stats.dangling}곳은 끊습니다</span>}
                {s.notes.map((n) => (
                  <span key={n} className="block text-xs text-dim">
                    {n}
                  </span>
                ))}
              </li>
            )
          })}
          {!planned.length && <li className="text-xs text-dim">데이터 항목은 바꾸지 않습니다</li>}
        </ul>
        {skipped.length > 0 && <p className="pt-1 text-xs text-dim">건너뛰는 항목: {skipped.map((id) => LABEL[id]).join(', ')}</p>}
        {src.damaged.length > 0 && <p className="pt-1 text-xs text-danger">손상돼 복원하지 않는 항목: {src.damaged.map((id) => LABEL[id]).join(', ')}</p>}
      </Group>
      {plan.history && (
        <Group title="히스토리">
          <p className={cx('text-sm', plan.history.action === 'replace' && 'text-danger')}>
            {plan.history.action === 'replace'
              ? `백업의 ${src.history?.records.toLocaleString()}장을 넣고, 모두 성공하면 백업에 없는 지금 그림을 지웁니다. 자동 백업에는 히스토리가 들어가지 않으니 필요하면 먼저 전체 백업을 파일로 만들어 두세요.`
              : `지금 없는 그림만 더합니다 (최대 ${src.history?.records.toLocaleString()}장).`}
            {plan.history.originals ? ' 원본 이미지도 넣습니다.' : ' 원본 없이 기록과 썸네일만 넣습니다.'}
          </p>
        </Group>
      )}
      {plan.warnings.length > 0 && (
        <Note tone="warn">
          {plan.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </Note>
      )}
      {props.safety ? (
        <Note tone="ok">먼저 지금 상태(히스토리 제외)를 앱 안에 자동 백업합니다 — 결과 화면에서 바로 되돌릴 수 있습니다.</Note>
      ) : (
        destructive && <Note tone="danger">자동 백업을 껐습니다. 덮어쓴 내용은 되돌릴 수 없습니다.</Note>
      )}
      <p className="text-xs text-dim">토큰(NovelAI·GitHub)은 백업에 없으므로 이 기기의 토큰은 그대로입니다.</p>
    </div>
  )
}

// ── 결과 화면 ───────────────────────────────────────────────────────────

function SummaryView(props: { summary: RestoreSummary; onRollback: (b: SafetyBackup) => void }): ReactNode {
  const s = props.summary
  const h = s.history
  return (
    <div className="flex flex-col gap-3" data-testid="restore-summary">
      <Note tone={s.problems.length || s.historyError ? 'warn' : 'ok'}>
        <p className="text-sm font-medium">
          복원을 마쳤습니다{s.problems.length ? ` — 파일 문제 ${s.problems.length}개` : ''}
        </p>
      </Note>
      <Group title="넣은 것">
        <ul className="flex flex-col gap-1 text-sm">
          {s.applied.filter((a) => ITEMLESS.includes(a.section) || a.stats.incoming > 0 || a.stats.current > 0).map((a) => (
            <li key={a.section}>
              <Check size={14} className="mr-1 inline text-ok" />
              {LABEL[a.section]} —{' '}
              {ITEMLESS.includes(a.section)
                ? a.action === 'overwrite'
                  ? '덮어씀'
                  : '합침'
                : a.action === 'overwrite'
                  ? `덮어씀 (${a.stats.incoming}개)`
                  : `합침 (${a.stats.added}개 더함${a.stats.identical ? `, 같은 것 ${a.stats.identical}개` : ''})`}
            </li>
          ))}
          {!s.applied.length && <li className="text-xs text-dim">데이터 항목은 바꾸지 않았습니다</li>}
        </ul>
        {s.skipped.length > 0 && (
          <p className="pt-1.5 text-xs text-dim" data-testid="restore-skipped">
            건너뜀: {s.skipped.map((x) => `${LABEL[x.section]}(${x.reason})`).join(', ')}
          </p>
        )}
      </Group>
      {(h || s.historyError) && (
        <Group title="히스토리">
          {h && (
            <p className="text-sm" data-testid="restore-history-result">
              {h.added.toLocaleString()}장 넣음
              {h.skippedExisting ? ` · 이미 있어 건너뜀 ${h.skippedExisting.toLocaleString()}장` : ''}
              {h.missingOriginals ? ` · 원본 없이 기록만 ${h.missingOriginals}장` : ''}
              {h.failed ? ` · 넣지 못함 ${h.failed}장` : ''}
              {h.removed ? ` · 백업에 없던 지금 그림 ${h.removed}장 지움` : ''}
            </p>
          )}
          {h && h.keptBecauseOfProblems > 0 && (
            <p className="pt-1 text-xs text-danger">문제가 있어 백업에 없던 지금 그림 {h.keptBecauseOfProblems}장은 지우지 않았습니다 (합쳐진 상태).</p>
          )}
          {s.historyError && <p className="pt-1 text-xs text-danger">{s.historyError}</p>}
        </Group>
      )}
      {s.missingProjectImages > 0 && (
        <Note tone="warn">복원한 프로젝트가 가리키는 그림 {s.missingProjectImages}장이 이 기기 히스토리에 없습니다 — 히스토리를 함께 복원해야 보입니다.</Note>
      )}
      {s.warnings.length > 0 && (
        <Note tone="warn">
          {s.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </Note>
      )}
      {s.problems.length > 0 && (
        <Note tone="danger" testId="restore-problems">
          <p className="font-medium">손상돼 건너뛰거나 비운 것 {s.problems.length}개</p>
          <ProblemList problems={s.problems} />
        </Note>
      )}
      {s.safety && (
        <Group title="되돌리기">
          <p className="pb-2 text-xs text-dim">
            복원 전 상태를 자동 백업했습니다 ({when(s.safety.createdAt)}, {formatBytes(s.safety.size)}). 결과가 마음에 들지 않으면 되돌리세요.
          </p>
          <Button className="w-full" onClick={() => props.onRollback(s.safety!)}>
            <RotateCcw size={16} />
            복원 전으로 되돌리기
          </Button>
        </Group>
      )}
    </div>
  )
}

// ── NAIS3 내보내기 ──────────────────────────────────────────────────────

function Nais3View(props: { plan: Nais3ExportPlan; withRefs: boolean; onRefs: (v: boolean) => void }): ReactNode {
  const { plan } = props
  return (
    <div className="flex flex-col gap-3" data-testid="nais3-export">
      <Group title="NAIS3로 내보내기 (.nais)">
        <p className="pb-1 text-xs leading-relaxed text-dim">NAIS3 가 "백업 가져오기"로 읽는 .nais 파일을 만듭니다. NAIS3 에 없는 NAIP 전용 데이터는 옮겨지지 않습니다.</p>
        <Row label="바이브·정밀 레퍼런스도 넣기" hint="그림이 들어가 파일이 커집니다">
          <Toggle label="바이브·정밀 레퍼런스도 넣기" checked={props.withRefs} onChange={props.onRefs} />
        </Row>
        <p className="pt-1 text-xs text-dim">내보내는 것: {plan.exported.map((e) => `${e.label} ${e.count}개`).join(', ') || '없음'}</p>
      </Group>
      <Note tone="warn" testId="nais3-lost">
        <p className="pb-1 text-sm font-medium">
          <AlertTriangle size={14} className="mr-1 inline" />
          NAIS3로 옮기지 못하는 것 (잃게 되는 것)
        </p>
        <ul className="flex flex-col gap-1">
          {plan.lost.map((l, i) => (
            <li key={i}>
              <span className="text-dim">[{l.scope}]</span> {l.text}
              {l.count && l.count > 1 ? ` (${l.count}개)` : ''}
              {l.items?.length ? <span className="text-dim"> — {l.items.join(', ')}{(l.count ?? 0) > l.items.length ? ' …' : ''}</span> : null}
            </li>
          ))}
        </ul>
      </Note>
    </div>
  )
}

// ── 화면 ───────────────────────────────────────────────────────────────

export default function BackupSheet(props: { onClose: () => void }): ReactNode {
  const [step, setStep] = useState<Step>({ name: 'home' })
  const [safetyList, setSafetyList] = useState<SafetyBackup[] | null>(null)
  const abort = useRef<AbortController | null>(null)
  const openSrc = useRef<RestoreSource | null>(null)
  const generating = useGeneration((g) => g.running)
  const busy = ['writing', 'opening', 'applying', 'nais3-writing'].includes(step.name)

  const refreshSafety = (): void => {
    listSafety()
      .then(setSafetyList)
      .catch(() => setSafetyList([]))
  }
  useEffect(refreshSafety, [])

  const releaseSource = (): void => {
    const src = openSrc.current
    openSrc.current = null
    if (src) void src.close()
  }
  useEffect(() => () => releaseSource(), [])

  const home = (): void => {
    releaseSource()
    setStep({ name: 'home' })
    refreshSafety()
  }

  const close = (): void => {
    if (step.name === 'applying') {
      toast('복원 중에는 닫을 수 없습니다', true)
      return
    }
    abort.current?.abort()
    releaseSource()
    props.onClose()
  }

  // ── 백업 쓰기
  const create = async (mode: BackupMode, sections: SectionId[]): Promise<void> => {
    const ctrl = new AbortController()
    abort.current = ctrl
    setStep({ name: 'writing', fileName: null, progress: null })
    try {
      const r = await createBackupFile(
        { mode, sections: mode === 'custom' ? sections : undefined },
        {
          signal: ctrl.signal,
          onFileChosen: (fileName) => setStep({ name: 'writing', fileName, progress: null }),
          onProgress: (progress) => setStep((s) => (s.name === 'writing' ? { ...s, progress } : s))
        }
      )
      if (!r) return setStep({ name: 'home' })
      setStep({ name: 'written', fileName: r.fileName, result: r.result })
    } catch (e) {
      setStep({
        name: 'failed',
        title: isAbort(e) ? '백업을 취소했습니다' : '백업을 만들지 못했습니다',
        message: isAbort(e) ? '쓰다 만 파일은 지웠습니다.' : `${errorText(e)} — 쓰다 만 파일은 지웠습니다.`
      })
    } finally {
      abort.current = null
    }
  }

  // ── 복원 파일 열기
  const openFile = async (
    file: { name: string; source: Parameters<typeof openRestoreSource>[0]['source']; close?: () => Promise<void> },
    init: { mode: RestoreMode; history: HistoryChoice }
  ): Promise<void> => {
    const ctrl = new AbortController()
    abort.current = ctrl
    setStep({ name: 'opening', fileName: file.name, progress: null })
    try {
      const src = await openRestoreSource(file, {
        signal: ctrl.signal,
        onProgress: (progress) => setStep((s) => (s.name === 'opening' ? { ...s, progress } : s))
      })
      openSrc.current = src
      const [preview, free] = await Promise.all([previewFor(src), freeSpace(true)])
      setStep({ name: 'preview', src, preview, free, initial: { ...init, sections: {}, originals: true, safety: true } })
    } catch (e) {
      setStep({
        name: 'failed',
        title: isAbort(e) ? '확인을 취소했습니다' : '이 파일을 열 수 없습니다',
        message: isAbort(e) ? '아무것도 바꾸지 않았습니다.' : `${errorText(e)} — 아무것도 바꾸지 않았습니다.`
      })
    } finally {
      abort.current = null
    }
  }

  const pickAndOpen = async (): Promise<void> => {
    try {
      const f = await pickRestoreFile()
      if (!f) return
      await openFile({ name: f.name, source: f, close: () => f.close() }, { mode: 'merge', history: 'merge' })
    } catch (e) {
      toast(`파일을 열지 못했습니다: ${errorText(e)}`, true)
    }
  }

  const rollback = async (b: SafetyBackup): Promise<void> => {
    try {
      await openFile(await safetyFile(b), { mode: 'overwrite', history: 'skip' })
    } catch (e) {
      toast(`자동 백업을 열지 못했습니다: ${errorText(e)}`, true)
    }
  }

  // ── 계획 → 확인 → 적용
  const toConfirm = async (src: RestoreSource, choice: RestoreChoice, safety: boolean, preview: SectionPreview[], free: number | null): Promise<void> => {
    try {
      const plan = await planFor(src, choice)
      setStep({ name: 'confirm', src, plan, choice, safety, preview, free })
    } catch (e) {
      toast(`복원 계획을 세우지 못했습니다: ${errorText(e)}`, true)
    }
  }

  const apply = async (src: RestoreSource, plan: RestorePlan, safety: boolean): Promise<void> => {
    const ctrl = new AbortController()
    abort.current = ctrl
    setStep({ name: 'applying', phase: safety ? 'safety' : 'sections', progress: null })
    try {
      // 확인 화면에 보여 준 계획 그대로 넣는다
      const summary = await applyRestore(src, plan, {
        safety,
        signal: ctrl.signal,
        onPhase: (phase) => setStep({ name: 'applying', phase, progress: null }),
        onProgress: (progress) => setStep((s) => (s.name === 'applying' ? { ...s, progress } : s))
      })
      openSrc.current = null
      setStep({ name: 'restored', summary })
      refreshSafety()
    } catch (e) {
      releaseSource()
      setStep({
        name: 'failed',
        title: isAbort(e) ? '복원을 취소했습니다' : '복원하지 못했습니다',
        message: `${isAbort(e) ? '' : `${errorText(e)} — `}자동 백업을 만들지 못했거나 그 전에 멈춰서 지금 데이터는 바뀌지 않았습니다.`
      })
    } finally {
      abort.current = null
    }
  }

  // ── NAIS3
  const nais3Sections = (withRefs: boolean): Nais3ExportSection[] => [...DEFAULT_NAIS3_EXPORT, ...(withRefs ? (['vibes', 'charRefs'] as const) : [])]
  const openNais3 = async (withRefs = false): Promise<void> => {
    try {
      const { data, plan } = await nais3Plan(nais3Sections(withRefs))
      setStep({ name: 'nais3', data, plan, withRefs })
    } catch (e) {
      toast(`내보낼 내용을 만들지 못했습니다: ${errorText(e)}`, true)
    }
  }
  const writeNais3 = async (data: BackupData, withRefs: boolean): Promise<void> => {
    setStep({ name: 'nais3-writing' })
    try {
      const r = await writeNais3File(data, nais3Sections(withRefs))
      if (!r) return setStep({ name: 'home' })
      setStep({ name: 'nais3-done', fileName: r.fileName, bytes: r.bytes })
    } catch (e) {
      setStep({ name: 'failed', title: '.nais 를 만들지 못했습니다', message: `${errorText(e)} — 쓰다 만 파일은 지웠습니다.` })
    }
  }

  // ── 본문·아래 버튼
  let body: ReactNode
  let footer: ReactNode = undefined
  let title = '백업·복원'
  switch (step.name) {
    case 'home':
      body = (
        <div className="flex flex-col gap-3">
          <Note tone="ok" testId="no-token-note">
            <Lock size={13} className="mr-1 inline" />
            NovelAI 토큰과 GitHub 토큰은 백업 파일에 절대 넣지 않습니다. 복원해도 이 기기의 토큰은 그대로입니다.
          </Note>
          <CreateGroup busy={busy} onCreate={(m, s) => void create(m, s)} />
          <Group title="복원" testId="backup-restore">
            <Button className="w-full" disabled={busy || generating} onClick={() => void pickAndOpen()}>
              <FolderOpen size={18} />
              백업 파일 열기
            </Button>
            <p className="py-2 text-xs leading-relaxed text-dim">
              {generating
                ? '생성 중에는 복원할 수 없습니다.'
                : 'NAIP 백업(.naipbackup), NAIS3 백업(.nais), 예전 JSON 백업을 열 수 있습니다. 고른 뒤 무엇이 들었고 무엇이 바뀌는지 먼저 보여 줍니다.'}
            </p>
          </Group>
          <Group title="NAIS3로 내보내기 (.nais)">
            <Button className="w-full" disabled={busy} onClick={() => void openNais3()}>
              <ArchiveRestore size={18} />
              NAIS3로 내보내기 (.nais)
            </Button>
            <p className="py-2 text-xs text-dim">옮기지 못하는 것을 먼저 보여 준 뒤 만듭니다.</p>
          </Group>
          <Group title="복원 전 자동 백업" testId="safety-list">
            {safetyList === null ? (
              <p className="py-2 text-xs text-dim">읽는 중…</p>
            ) : !safetyList.length ? (
              <p className="py-2 text-xs text-dim">아직 없습니다. 복원할 때 지금 상태(히스토리 제외)를 여기에 자동으로 남깁니다 (최근 3개).</p>
            ) : (
              <ul className="flex flex-col">
                {safetyList.map((b) => (
                  <li key={b.name} className="border-t border-line py-2 first:border-t-0">
                    <div className="flex items-center gap-2">
                      <History size={16} className="shrink-0 text-dim" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">{when(b.createdAt)}</div>
                        <div className="truncate text-xs text-dim">
                          {b.note ?? '복원 전'} · {formatBytes(b.size)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-1.5 flex gap-1.5">
                      <Button className="flex-1" disabled={busy || generating} onClick={() => void rollback(b)}>
                        <RotateCcw size={16} />
                        되돌리기
                      </Button>
                      <Button
                        className="flex-1"
                        disabled={busy}
                        onClick={() =>
                          void exportSafety(b)
                            .then((ok) => ok && toast('자동 백업을 파일로 저장했습니다'))
                            .catch((e) => toast(`저장하지 못했습니다: ${errorText(e)}`, true))
                        }
                      >
                        <FileDown size={16} />
                        파일로 저장
                      </Button>
                      <IconButton
                        label="자동 백업 지우기"
                        className="h-11 w-11"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`${when(b.createdAt)} 자동 백업을 지울까요? 되돌릴 수 없습니다.`)) return
                          void removeSafety(b)
                            .then(refreshSafety)
                            .catch((e) => toast(`지우지 못했습니다: ${errorText(e)}`, true))
                        }}
                      >
                        <Trash2 size={18} />
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Group>
        </div>
      )
      break
    case 'writing':
      title = '백업 만드는 중'
      body = (
        <div className="flex flex-col gap-3" data-testid="backup-writing">
          <p className="text-sm break-all">{step.fileName ?? '저장할 곳을 고르는 중…'}</p>
          <Progress progress={step.progress} />
          <p className="text-xs text-dim">취소하면 쓰다 만 파일을 지웁니다.</p>
        </div>
      )
      footer = (
        <Button variant="danger" className="flex-1" onClick={() => abort.current?.abort()}>
          취소
        </Button>
      )
      break
    case 'written': {
      const r = step.result
      title = '백업을 만들었습니다'
      body = (
        <div className="flex flex-col gap-3" data-testid="backup-written">
          <Note tone="ok">
            <p className="text-sm font-medium break-all">{step.fileName}</p>
            <p>
              {formatBytes(r.bytes)} · 항목 {r.entries.toLocaleString()}개 · {when(r.manifest.createdAt)}
            </p>
          </Note>
          <Group title="담은 것">
            <ul className="flex flex-col gap-0.5 text-sm">
              {r.manifest.sections.map((id) => (
                <li key={id}>
                  <Check size={14} className="mr-1 inline text-ok" />
                  {LABEL[id]}
                  {r.manifest.counts[id] !== undefined && id !== 'settings' && id !== 'prompt' ? ` ${r.manifest.counts[id]!.toLocaleString()}` : ''}
                </li>
              ))}
            </ul>
            {r.skippedOriginals > 0 && <p className="pt-1.5 text-xs text-danger">원본 파일이 없어 기록만 담은 그림 {r.skippedOriginals}장</p>}
            <p className="pt-1.5 text-xs text-dim">토큰은 들어가지 않았습니다. 생성 대기열은 담지 않습니다.</p>
          </Group>
        </div>
      )
      footer = (
        <Button variant="primary" className="flex-1" onClick={home}>
          확인
        </Button>
      )
      break
    }
    case 'failed':
      title = step.title
      body = (
        <Note tone="warn" testId="backup-failed">
          <p className="text-sm font-medium">{step.title}</p>
          <p>{step.message}</p>
        </Note>
      )
      footer = (
        <Button variant="primary" className="flex-1" onClick={home}>
          확인
        </Button>
      )
      break
    case 'opening':
      title = '백업 확인 중'
      body = (
        <div className="flex flex-col gap-3" data-testid="restore-opening">
          <p className="text-sm break-all">{step.fileName}</p>
          <Progress progress={step.progress} label={step.progress ? undefined : '파일을 읽는 중…'} />
          <p className="text-xs text-dim">모든 항목의 체크섬을 확인합니다. 아직 아무것도 바꾸지 않습니다.</p>
        </div>
      )
      footer = (
        <Button variant="danger" className="flex-1" onClick={() => abort.current?.abort()}>
          취소
        </Button>
      )
      break
    case 'preview':
      title = '복원 미리보기'
      body = (
        <PreviewView
          key={step.src.fileName}
          src={step.src}
          preview={step.preview}
          free={step.free}
          busy={busy}
          initial={step.initial}
          onNext={(choice, safety) => void toConfirm(step.src, choice, safety, step.preview, step.free)}
        />
      )
      footer = (
        <Button variant="ghost" className="flex-1" onClick={home}>
          취소
        </Button>
      )
      break
    case 'confirm': {
      const destructive = isDestructive(step.plan)
      title = '마지막 확인'
      body = <ConfirmView src={step.src} plan={step.plan} safety={step.safety} />
      footer = (
        <>
          <Button
            className="flex-1"
            onClick={() =>
              setStep({ name: 'preview', src: step.src, preview: step.preview, free: step.free, initial: { ...step.choice, safety: step.safety } })
            }
          >
            뒤로
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} className="flex-1" onClick={() => void apply(step.src, step.plan, step.safety)}>
            복원 시작
          </Button>
        </>
      )
      break
    }
    case 'applying':
      title = '복원 중'
      body = (
        <div className="flex flex-col gap-3" data-testid="restore-applying">
          <p className="text-sm">{RESTORE_PHASE[step.phase]}</p>
          {step.phase === 'history' && <Progress progress={step.progress} />}
          <p className="text-xs text-dim">
            {step.phase === 'history' ? '취소하면 그때까지 넣은 그림은 남고, 지금 히스토리는 지우지 않습니다.' : '잠시만 기다려 주세요.'}
          </p>
        </div>
      )
      footer =
        step.phase === 'history' ? (
          <Button variant="danger" className="flex-1" onClick={() => abort.current?.abort()}>
            히스토리 넣기 취소
          </Button>
        ) : undefined
      break
    case 'restored':
      title = '복원 결과'
      body = <SummaryView summary={step.summary} onRollback={(b) => void rollback(b)} />
      footer = (
        <Button variant="primary" className="flex-1" onClick={home}>
          확인
        </Button>
      )
      break
    case 'nais3':
      title = 'NAIS3로 내보내기'
      body = <Nais3View plan={step.plan} withRefs={step.withRefs} onRefs={(v) => void openNais3(v)} />
      footer = (
        <>
          <Button className="flex-1" onClick={home}>
            뒤로
          </Button>
          <Button variant="primary" className="flex-1" onClick={() => void writeNais3(step.data, step.withRefs)}>
            이대로 내보내기
          </Button>
        </>
      )
      break
    case 'nais3-writing':
      title = 'NAIS3로 내보내는 중'
      body = <Progress progress={null} label=".nais 파일을 쓰는 중…" />
      break
    case 'nais3-done':
      title = '내보냈습니다'
      body = (
        <Note tone="ok" testId="nais3-done">
          <p className="text-sm font-medium break-all">{step.fileName}</p>
          <p>{formatBytes(step.bytes)} — NAIS3 에서 "백업 가져오기"로 여세요. NAIS3 는 들어 있는 항목을 이 내용으로 통째로 바꿉니다.</p>
        </Note>
      )
      footer = (
        <Button variant="primary" className="flex-1" onClick={home}>
          확인
        </Button>
      )
      break
  }

  return (
    <Sheet title={title} onClose={close} footer={footer}>
      {body}
    </Sheet>
  )
}
