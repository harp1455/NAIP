/**
 * 내보내기 — 이름 규칙(파일·폴더 템플릿, 번호, 중복 처리)과 경로 미리보기, 변환 프리셋, 목록 파일, 이미지 코드,
 * 그리고 실행(진행·취소·요약). 원본(히스토리)은 바꾸지 않는다.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Copy, FileDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { isNative } from '../../lib/native'
import { copyTextWithToast } from '../../lib/share'
import { cx } from '../../lib/util'
import {
  BLANK_PRESET,
  CHARACTER_AXIS,
  MANIFEST_COLUMNS,
  MANIFEST_COLUMN_LABEL,
  PATH_STATUS_LABEL,
  TEMPLATE_VARIABLES,
  describePreset,
  presetNotes,
  projectCodeList,
  useProjects,
  validatePreset,
  type DuplicatePolicy,
  type IndexScope,
  type ManifestFormat,
  type NamingSettings,
  type PlatformPreset,
  type Project
} from '../../project'
import { buildExportPlan, describeSummary, existingPaths, exportPreset, runExport, type ExportSettings, type ExportSummary, type ExportTarget } from '../../project/save'
import { Button, Empty, IconButton, Row, Section, Select, Sheet, TextInput, Toggle } from '../ui'
import { Chip, DraftInput, Field, NumberInput, Segmented } from './common'

const INDEX_SCOPES: { value: IndexScope; label: string }[] = [
  { value: 'combination', label: '조합마다' },
  { value: 'character', label: '캐릭터마다' },
  { value: 'folder', label: '폴더마다' },
  { value: 'global', label: '전체 이어서' }
]

const DUPLICATES: { value: DuplicatePolicy; label: string }[] = [
  { value: 'suffix', label: '뒤에 번호 붙이기 (_2)' },
  { value: 'overwrite', label: '덮어쓰기' },
  { value: 'skip', label: '건너뛰기' },
  { value: 'error', label: '내보내기 막기' }
]

const FORMATS: { value: ManifestFormat; label: string }[] = [
  { value: 'csv', label: 'CSV (엑셀)' },
  { value: 'json', label: 'JSON' },
  { value: 'txt', label: 'TXT' },
  { value: 'md', label: 'Markdown 표' }
]

const STATUS_COLOR: Record<string, string> = {
  ok: 'text-dim',
  renamed: 'text-tag-meta',
  update: 'text-accent',
  overwrite: 'text-danger',
  skip: 'text-dim line-through',
  error: 'text-danger'
}

export function ExportView(props: { project: Project }): ReactNode {
  const p = props.project
  const presets = useProjects((s) => s.presets)
  const [settings, setSettings] = useState<ExportSettings>({ target: isNative ? 'gallery' : 'zip', onlyNotExported: false, renameExported: false })
  const [existing, setExisting] = useState<string[]>([])
  const [showAll, setShowAll] = useState(false)
  const [presetSheet, setPresetSheet] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const abort = useRef<AbortController | null>(null)
  const naming = p.naming
  const setNaming = (x: Partial<NamingSettings>): void => useProjects.getState().patch(p.id, { naming: { ...naming, ...x } })
  const fileRef = useRef<string>(naming.fileTemplate)
  fileRef.current = naming.fileTemplate

  useEffect(() => {
    let live = true
    void existingPaths(settings.target).then((list) => live && setExisting(list))
    return () => {
      live = false
    }
  }, [settings.target, summary])

  const plan = useMemo(() => buildExportPlan(p, presets, settings, existing), [p, presets, settings, existing])
  const preset = exportPreset(p, presets)
  const entries = plan.entries
  const todo = entries.filter((e) => e.path.status !== 'skip' && e.path.status !== 'error').length
  const counts = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.path.status]: (acc[e.path.status] ?? 0) + 1 }), {})
  const axisVars = p.axes.flatMap((a) => [a.name, ...(a.key ? [a.key] : [])])
  const codeList = useMemo(() => projectCodeList(p, plan), [p, plan])

  const run = async (): Promise<void> => {
    setSummary(null)
    abort.current = new AbortController()
    setProgress({ done: 0, total: todo, label: '' })
    try {
      const r = await runExport(p, presets, settings, {
        signal: abort.current.signal,
        onProgress: (done, total, label) => setProgress({ done, total, label })
      })
      setSummary(r)
    } catch (e) {
      setSummary({ saved: 0, skipped: 0, failed: 0, where: '', manifestPath: null, warnings: [], errors: [(e as Error).message], cancelled: false })
    } finally {
      setProgress(null)
      abort.current = null
    }
  }

  const insertVar = (name: string): void => setNaming({ fileTemplate: `${fileRef.current}${fileRef.current && !/[_\-\s/]$/.test(fileRef.current) ? naming.separator : ''}{${name}}` })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 p-3">
          <Section title="대상">
            <div className="flex flex-col gap-2 pb-2">
              <Segmented
                label="내보낼 그림"
                value={settings.onlyNotExported ? 'new' : 'all'}
                onChange={(v) => setSettings({ ...settings, onlyNotExported: v === 'new' })}
                options={[
                  { value: 'all', label: '채택 전부' },
                  { value: 'new', label: '아직 안 내보낸 것만' }
                ]}
              />
              <Segmented<ExportTarget>
                label="저장할 곳"
                value={settings.target}
                onChange={(target) => setSettings({ ...settings, target })}
                options={isNative ? [{ value: 'gallery', label: '갤러리 (사진/NAIP)' }, { value: 'zip', label: 'ZIP 파일 하나로' }] : [{ value: 'zip', label: 'ZIP 파일 (내려받기)' }]}
              />
              <p className="text-[11px] text-dim">
                {settings.target === 'gallery'
                  ? '사진/NAIP 아래에 폴더째 저장합니다. 목록 파일은 안드로이드 규칙상 다운로드/NAIP 아래 같은 폴더에 저장됩니다.'
                  : '폴더 구조와 목록 파일을 담은 ZIP 하나를 만듭니다.'}
              </p>
              <div className="rounded-lg border border-line bg-field px-3">
                <Row label="이미 내보낸 그림도 새 이름으로" hint="끄면 지난번 경로를 그대로 쓰고(교체한 새 버전도 같은 파일로) 새 그림만 이어서 번호를 받습니다">
                  <Toggle label="이미 내보낸 그림도 새 이름으로" checked={settings.renameExported} onChange={(renameExported) => setSettings({ ...settings, renameExported })} />
                </Row>
              </div>
            </div>
          </Section>

          <Section title="이름 규칙">
            <div className="flex flex-col gap-2 pb-2">
              <Field label="파일 이름 (확장자 제외)">
                <DraftInput label="파일 이름 템플릿" value={naming.fileTemplate} onCommit={(fileTemplate) => setNaming({ fileTemplate })} className="font-mono" />
              </Field>
              <div className="flex flex-wrap gap-1" aria-label="변수 (눌러서 파일 이름 끝에 넣기)">
                {[...TEMPLATE_VARIABLES.map((v) => ({ name: v.name, label: v.label })), ...axisVars.map((n) => ({ name: n, label: '축' }))].map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    title={v.label}
                    onClick={() => insertVar(v.name)}
                    className="h-7 rounded-md border border-line px-1.5 font-mono text-[11px] text-dim active:bg-raised"
                  >
                    {`{${v.name}}`}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-dim">
                {'{index:03} → 001, {date:YYYY-MM-DD}, {character:upper}, {character:4} → 앞 4글자. 빈 변수는 옆 구분자와 함께 사라집니다.'}
              </p>
              <Segmented
                label="폴더 나누기"
                value={naming.folderMode}
                onChange={(folderMode) => setNaming({ folderMode })}
                options={[
                  { value: 'nested', label: '폴더로 나누기' },
                  { value: 'flat', label: '한 폴더에' }
                ]}
              />
              <div className="grid grid-cols-2 gap-2">
                <Field label="맨 앞 폴더">
                  <DraftInput label="맨 앞 폴더 템플릿" value={naming.rootFolder} placeholder="(없음)" onCommit={(rootFolder) => setNaming({ rootFolder })} className="font-mono" />
                </Field>
                <Field label="하위 폴더 ('/'로 단계)">
                  <DraftInput label="폴더 템플릿" value={naming.folderTemplate} onCommit={(folderTemplate) => setNaming({ folderTemplate })} className={cx('font-mono', naming.folderMode === 'flat' && 'opacity-50')} />
                </Field>
                <Field label="구분자">
                  <DraftInput label="구분자" value={naming.separator} onCommit={(separator) => setNaming({ separator: separator.slice(0, 3) })} className="font-mono" />
                </Field>
                <Field label="시작 번호">
                  <NumberInput label="시작 번호" className="w-full" value={naming.startIndex} min={0} max={99999} onCommit={(startIndex) => setNaming({ startIndex: Math.floor(startIndex) })} />
                </Field>
                <Field label="번호를 새로 셀 단위">
                  <Select label="번호 범위" value={naming.indexScope} options={INDEX_SCOPES} onChange={(indexScope) => setNaming({ indexScope })} />
                </Field>
                <Field label="같은 이름이 있으면">
                  <Select label="중복 처리" value={naming.duplicate} options={DUPLICATES} onChange={(duplicate) => setNaming({ duplicate })} />
                </Field>
                <Field label="{custom} 값">
                  <DraftInput label="사용자 지정 글자" value={naming.custom} onCommit={(custom) => setNaming({ custom })} />
                </Field>
                <Field label="이름 최대 글자">
                  <NumberInput label="이름 최대 글자" className="w-full" value={naming.maxLength} min={8} max={120} onCommit={(maxLength) => setNaming({ maxLength: Math.floor(maxLength) })} />
                </Field>
              </div>
              <div className="rounded-lg border border-line bg-field px-3">
                <Row label="값 안의 공백을 구분자로">
                  <Toggle label="값 안의 공백을 구분자로" checked={naming.replaceSpaces} onChange={(replaceSpaces) => setNaming({ replaceSpaces })} />
                </Row>
              </div>
            </div>
          </Section>

          <Section title={`미리보기 ${entries.length}장`}>
            <div className="pb-2">
              <p className="text-xs text-dim">
                내보낼 {todo}장
                {counts.renamed ? ` · 번호 붙임 ${counts.renamed}` : ''}
                {counts.update ? ` · 지난 파일 새로 씀 ${counts.update}` : ''}
                {counts.overwrite ? ` · 덮어씀 ${counts.overwrite}` : ''}
                {counts.skip ? ` · 건너뜀 ${counts.skip}` : ''}
                {counts.error ? ` · 오류 ${counts.error}` : ''}
                {existing.length ? ` · 기기에 있는 파일 ${existing.length}개와 비교` : ''}
              </p>
              {plan.preview.warnings.map((w) => (
                <p key={w} className="mt-1 flex gap-1.5 text-xs text-tag-meta">
                  <AlertTriangle size={14} className="shrink-0" />
                  {w}
                </p>
              ))}
              {entries.length === 0 ? (
                <Empty>채택한 그림이 없습니다. 행렬에서 조합을 눌러 고르세요</Empty>
              ) : (
                <ul className="mt-2 flex flex-col gap-1" aria-label="경로 미리보기">
                  {(showAll ? entries : entries.slice(0, 30)).map((e) => (
                    <li key={e.candidate.image.id} className="rounded-md bg-field px-2.5 py-1.5">
                      <div className={cx('break-all font-mono text-[12px]', e.path.status === 'skip' && 'line-through opacity-60')}>{e.path.path}</div>
                      <div className="flex gap-2 text-[11px]">
                        {e.code && <span className="font-mono text-dim">{e.code}</span>}
                        {e.path.status !== 'ok' && <span className={STATUS_COLOR[e.path.status]}>{PATH_STATUS_LABEL[e.path.status]}</span>}
                        {e.path.kept && <span className="text-dim">지난 이름 유지</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {!showAll && entries.length > 30 && (
                <Button variant="ghost" className="mt-1 w-full" onClick={() => setShowAll(true)}>
                  {entries.length - 30}개 더 보기
                </Button>
              )}
            </div>
          </Section>

          <Section title="변환">
            <div className="flex flex-col gap-2 pb-2">
              <div className="flex gap-2">
                <Select
                  label="변환 프리셋"
                  className="flex-1"
                  value={p.convertPresetId ?? ''}
                  options={[{ value: '', label: '변환 안 함 (원본 형식)' }, ...presets.map((x) => ({ value: x.id, label: `${x.name} — ${describePreset(x)}` }))]}
                  onChange={(id) => useProjects.getState().patch(p.id, { convertPresetId: id || null })}
                />
                <Button variant="default" onClick={() => setPresetSheet(true)}>
                  프리셋 관리
                </Button>
              </div>
              {!preset ? (
                <div className="rounded-lg border border-line bg-field px-3">
                  <Row label="NAI 메타데이터 지우기" hint="PNG의 프롬프트 기록과 알파 채널 숨은 정보를 지운 PNG로 (원본은 그대로)">
                    <Toggle label="NAI 메타데이터 지우기" checked={!!p.exportStripMeta} onChange={(on) => useProjects.getState().patch(p.id, { exportStripMeta: on })} />
                  </Row>
                </div>
              ) : (
                <p className="text-[11px] text-dim">
                  {describePreset(preset)}. 변환하면 메타데이터는 남지 않습니다.
                  {preset.maxBytes ? ' 최대 용량은 최선 노력 목표입니다 — 품질 하한까지 낮춰도 넘으면 가장 작은 결과를 쓰고 경고합니다.' : ''}
                </p>
              )}
              {presets.length === 0 && (
                <p className="text-[11px] text-dim">플랫폼별 제한(형식·크기·용량)은 앱에 미리 넣어 두지 않았습니다. 업로드할 곳의 안내를 보고 프리셋을 직접 만드세요.</p>
              )}
            </div>
          </Section>

          <Section title="목록 파일 · 이미지 코드" defaultOpen={false}>
            <ManifestEditor project={p} codeList={codeList} />
          </Section>

          {summary && <SummaryCard summary={summary} />}
        </div>
      </div>
      <div className="shrink-0 border-t border-line bg-panel p-3">
        {progress ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs" aria-live="polite">
                {progress.done}/{progress.total} · {progress.label}
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
            <Button variant="danger" onClick={() => abort.current?.abort()}>
              취소
            </Button>
          </div>
        ) : (
          <Button variant="primary" className="w-full" disabled={!todo || !plan.preview.ok} onClick={() => void run()}>
            <FileDown size={16} />
            {!plan.preview.ok ? '같은 이름 오류를 먼저 해결해 주세요' : todo ? `${todo}장 내보내기` : '내보낼 그림이 없습니다'}
          </Button>
        )}
      </div>
      {presetSheet && <PresetManager project={p} onClose={() => setPresetSheet(false)} />}
    </div>
  )
}

function SummaryCard(props: { summary: ExportSummary }): ReactNode {
  const s = props.summary
  return (
    <section aria-label="내보내기 결과" className={cx('rounded-xl border p-3', s.errors.length || s.cancelled ? 'border-danger/50' : 'border-ok/50')}>
      <h3 className="text-sm font-semibold">{describeSummary(s)}</h3>
      {s.where && <p className="mt-1 break-all text-xs text-dim">저장한 곳: {s.where}</p>}
      {s.manifestPath && <p className="break-all text-xs text-dim">목록 파일: {s.manifestPath}</p>}
      {s.errors.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-danger">
          {s.errors.slice(0, 20).map((e) => (
            <li key={e}>{e}</li>
          ))}
          {s.errors.length > 20 && <li>외 {s.errors.length - 20}개</li>}
        </ul>
      )}
      {s.warnings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-tag-meta">
          {s.warnings.slice(0, 20).map((w) => (
            <li key={w}>{w}</li>
          ))}
          {s.warnings.length > 20 && <li>외 {s.warnings.length - 20}개</li>}
        </ul>
      )}
    </section>
  )
}

function ManifestEditor(props: { project: Project; codeList: string }): ReactNode {
  const p = props.project
  const m = p.manifest
  const set = (x: Partial<typeof m>): void => useProjects.getState().patch(p.id, { manifest: { ...m, ...x } })
  const setCodes = (x: Partial<typeof p.codes>): void => useProjects.getState().patch(p.id, { codes: { ...p.codes, ...x } })
  const axisCols = [
    ...(p.characters.length ? [{ key: `axis:${CHARACTER_AXIS}`, label: '캐릭터 (축)' }] : []),
    ...p.axes.map((a) => ({ key: `axis:${a.id}`, label: `${a.name} (축)` }))
  ]
  const cols = [...MANIFEST_COLUMNS.map((k) => ({ key: k as string, label: MANIFEST_COLUMN_LABEL[k] })), ...axisCols]
  const toggleCol = (key: string): void =>
    set({ columns: (m.columns as string[]).includes(key) ? m.columns.filter((c) => c !== key) : ([...m.columns, key] as typeof m.columns) })
  return (
    <div className="flex flex-col gap-2 pb-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="목록 형식">
          <Select label="목록 형식" value={m.format} options={FORMATS} onChange={(format) => set({ format })} />
        </Field>
        <div className="flex flex-col justify-end gap-1">
          <label className="flex h-11 items-center justify-between gap-2 rounded-lg border border-line bg-field px-3 text-xs">
            엑셀용 BOM
            <Toggle label="엑셀용 BOM" checked={m.bom} disabled={m.format !== 'csv'} onChange={(bom) => set({ bom })} />
          </label>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-field px-3">
        <Row label="수식 방지" hint="=,+,-,@로 시작하는 칸 앞에 ' (CSV)">
          <Toggle label="수식 방지" checked={m.guardFormulas} disabled={m.format !== 'csv'} onChange={(guardFormulas) => set({ guardFormulas })} />
        </Row>
      </div>
      <Field label="열 (누르는 순서대로)">
        <div className="flex flex-wrap gap-1.5">
          {cols.map((c) => (
            <Chip key={c.key} on={(m.columns as string[]).includes(c.key)} onClick={() => toggleCol(c.key)} label={`열 ${c.label}`}>
              {c.label}
            </Chip>
          ))}
        </div>
      </Field>
      <Field label="설명 템플릿 (그림에 설명이 없을 때)">
        <DraftInput label="설명 템플릿" value={m.descriptionTemplate} onCommit={(descriptionTemplate) => set({ descriptionTemplate })} className="font-mono" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="이미지 코드 패턴">
          <DraftInput label="코드 패턴" value={p.codes.pattern} onCommit={(pattern) => setCodes({ pattern })} className="font-mono" />
        </Field>
        <Field label="코드 목록 한 줄">
          <DraftInput label="코드 목록 템플릿" value={p.codes.listTemplate} onCommit={(listTemplate) => setCodes({ listTemplate })} className="font-mono" />
        </Field>
      </div>
      <p className="text-[11px] text-dim">{'{char} = 캐릭터 코드(A, B …), {n:03} = 캐릭터 안 번호. 코드는 채택 칸에 붙어 교체해도 그대로입니다.'}</p>
      {props.codeList ? (
        <div className="rounded-lg border border-line bg-field">
          <div className="flex items-center border-b border-line pl-3">
            <span className="flex-1 text-xs text-dim">채팅 프롬프트용 코드 목록 (미리보기)</span>
            <IconButton label="코드 목록 복사" onClick={() => void copyTextWithToast(props.codeList, '코드 목록을')}>
              <Copy size={16} />
            </IconButton>
          </div>
          <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px]">{props.codeList}</pre>
        </div>
      ) : null}
    </div>
  )
}

function PresetManager(props: { project: Project; onClose: () => void }): ReactNode {
  const presets = useProjects((s) => s.presets)
  const [editing, setEditing] = useState<PlatformPreset | 'new' | null>(null)
  return (
    <Sheet
      title="변환 프리셋"
      onClose={props.onClose}
      footer={
        <Button variant="primary" className="flex-1" onClick={() => setEditing('new')}>
          <Plus size={16} />
          프리셋 만들기
        </Button>
      }
    >
      <p className="mb-2 text-xs text-dim">
        업로드할 곳(캐릭터 챗 플랫폼 등)의 형식·최대 크기·용량은 직접 확인해 적어 주세요. 앱은 확인되지 않은 수치를 미리 넣어 두지 않습니다.
      </p>
      {presets.length === 0 ? (
        <Empty>프리셋이 없습니다</Empty>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {presets.map((x) => (
            <li key={x.id} className="flex items-center gap-1 rounded-lg border border-line bg-field py-1 pl-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{x.name}</div>
                <div className="truncate text-[11px] text-dim">{describePreset(x)}</div>
              </div>
              <IconButton label={`${x.name} 편집`} onClick={() => setEditing(x)}>
                <Pencil size={16} />
              </IconButton>
              <IconButton
                label={`${x.name} 삭제`}
                onClick={() => {
                  if (window.confirm(`"${x.name}" 프리셋을 지울까요? 이 프리셋을 쓰던 프로젝트는 "변환 안 함"으로 바뀝니다.`)) useProjects.getState().removePreset(x.id)
                }}
              >
                <Trash2 size={16} className="text-danger" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <PresetEditSheet
          preset={editing === 'new' ? null : editing}
          onSaved={(id) => useProjects.getState().patch(props.project.id, { convertPresetId: id })}
          onClose={() => setEditing(null)}
        />
      )}
    </Sheet>
  )
}

function PresetEditSheet(props: { preset: PlatformPreset | null; onSaved: (id: string) => void; onClose: () => void }): ReactNode {
  const init = props.preset ?? { ...BLANK_PRESET }
  const [name, setName] = useState(init.name)
  const [format, setFormat] = useState(init.format)
  const [maxWidth, setMaxWidth] = useState(init.maxWidth ? String(init.maxWidth) : '')
  const [maxHeight, setMaxHeight] = useState(init.maxHeight ? String(init.maxHeight) : '')
  const [maxKb, setMaxKb] = useState(init.maxBytes ? String(Math.round(init.maxBytes / 1024)) : '')
  const [quality, setQuality] = useState(String(Math.round((init.quality ?? 0.9) * 100)))
  const [minQuality, setMinQuality] = useState(String(Math.round((init.minQuality ?? 0.6) * 100)))
  const [background, setBackground] = useState(init.background ?? '#ffffff')
  const [note, setNote] = useState(init.note ?? '')
  const num = (t: string): number | undefined => (t.trim() === '' ? undefined : Number(t))
  const draft: Omit<PlatformPreset, 'id'> = {
    name,
    format,
    ...(num(maxWidth) !== undefined ? { maxWidth: num(maxWidth) } : {}),
    ...(num(maxHeight) !== undefined ? { maxHeight: num(maxHeight) } : {}),
    ...(num(maxKb) !== undefined ? { maxBytes: Math.round(num(maxKb)! * 1024) } : {}),
    ...(format !== 'png' && num(quality) !== undefined ? { quality: num(quality)! / 100 } : {}),
    ...(format !== 'png' && num(minQuality) !== undefined ? { minQuality: num(minQuality)! / 100 } : {}),
    ...(format === 'jpeg' ? { background } : {}),
    ...(note.trim() ? { note: note.trim() } : {})
  }
  const errors = validatePreset(draft)
  const notes = presetNotes(draft)
  const digits = (set: (v: string) => void) => (v: string) => set(v.replace(/\D/g, ''))
  return (
    <Sheet
      title={props.preset ? '프리셋 편집' : '새 프리셋'}
      onClose={props.onClose}
      footer={
        <Button
          variant="primary"
          className="flex-1"
          disabled={errors.length > 0}
          onClick={() => {
            const id = useProjects.getState().savePreset({ ...draft, ...(props.preset ? { id: props.preset.id } : {}) })
            props.onSaved(id)
            props.onClose()
          }}
        >
          저장하고 이 프로젝트에 쓰기
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="이름">
          <TextInput label="프리셋 이름" value={name} onChange={setName} placeholder="예: 내 챗 플랫폼 프로필" />
        </Field>
        <Segmented
          label="형식"
          value={format}
          onChange={setFormat}
          options={[
            { value: 'webp', label: 'WebP' },
            { value: 'jpeg', label: 'JPEG' },
            { value: 'png', label: 'PNG' }
          ]}
        />
        <div className="grid grid-cols-3 gap-2">
          <Field label="최대 가로(px)">
            <TextInput label="최대 가로" inputMode="numeric" value={maxWidth} onChange={digits(setMaxWidth)} placeholder="제한 없음" />
          </Field>
          <Field label="최대 세로(px)">
            <TextInput label="최대 세로" inputMode="numeric" value={maxHeight} onChange={digits(setMaxHeight)} placeholder="제한 없음" />
          </Field>
          <Field label="최대 용량(KB)">
            <TextInput label="최대 용량" inputMode="numeric" value={maxKb} onChange={digits(setMaxKb)} placeholder="제한 없음" />
          </Field>
        </div>
        {format !== 'png' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="품질 (%)">
              <TextInput label="품질" inputMode="numeric" value={quality} onChange={digits(setQuality)} />
            </Field>
            <Field label="용량을 맞출 때 품질 하한 (%)">
              <TextInput label="품질 하한" inputMode="numeric" value={minQuality} onChange={digits(setMinQuality)} />
            </Field>
          </div>
        )}
        {format === 'jpeg' && (
          <Field label="투명한 부분을 채울 색">
            <TextInput label="배경색" value={background} onChange={setBackground} />
          </Field>
        )}
        <Field label="메모 (어디에 쓰는지, 확인한 안내 등)">
          <TextInput label="프리셋 메모" value={note} onChange={setNote} />
        </Field>
        {maxKb && <p className="text-[11px] text-dim">최대 용량은 최선 노력입니다 — 정해진 횟수만 다시 인코딩하고, 못 맞추면 가장 작은 결과와 경고를 냅니다.</p>}
        {errors.map((e) => (
          <p key={e} className="text-xs text-danger">
            {e}
          </p>
        ))}
        {notes.map((n) => (
          <p key={n} className="text-xs text-tag-meta">
            {n}
          </p>
        ))}
      </div>
    </Sheet>
  )
}
