import { useEffect, useState, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { shareImage as shareFile } from '../lib/native'
import { useCharacters } from '../stores/characters'
import { useFragments } from '../stores/fragments'
import { useScenes } from '../stores/scenes'
import { useTagUsage } from '../stores/tagUsage'
import { useHistory } from '../stores/history'
import { usePrompt } from '../stores/prompt'
import { anlasOf, DELAY_MAX, DELAY_MIN, useSettings } from '../stores/settings'
import { CURRENT_BUILD, useUpdate } from '../stores/update'
import { useGeneration } from '../stores/generation'
import { V5Gauge } from './V5Gauge'
import { Button, IconButton, Row, Select, SliderRow, TextInput, Toggle } from './ui'

const LIMITS = [0, 200, 500, 1000, 3000].map((value) => ({
  value,
  label: value ? `최근 ${value.toLocaleString()}장` : '제한 없음'
}))

const TIER_LABEL = { paper: 'Paper (무료)', tablet: 'Tablet', scroll: 'Scroll', opus: 'Opus' } as const

function Group(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="rounded-xl border border-line bg-panel px-3 py-2">
      <h3 className="py-1 text-xs font-semibold text-dim">{props.title}</h3>
      {props.children}
    </section>
  )
}

/** 자동완성에서 고른 태그 기록 — 다음 추천에서 앞에 나온다 */
function TagUsageRow(): ReactNode {
  const { entries, clear } = useTagUsage()
  const n = Object.keys(entries).length
  return (
    <Row label="자주 쓴 태그 우선" hint={`자동완성에서 고른 태그 ${n}개를 기억해 추천 맨 앞(★)에 보여 줍니다`}>
      <Button
        variant="ghost"
        disabled={n === 0}
        onClick={() => window.confirm('기억한 태그 기록을 모두 지울까요?') && clear()}
      >
        기록 지우기
      </Button>
    </Row>
  )
}

/** 지난 배치에서 장당 어디에 시간이 들었는지 — 느릴 때 원인을 가려내기 위한 표시 */
function SpeedReport(): ReactNode {
  const t = useGeneration((g) => g.lastBatch)
  const delayMax = useSettings((x) => x.delayMax)
  if (!t) return null
  const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}초`
  const mb = (bytes: number): string => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`)
  // 설정한 간격보다 1초 넘게 더 쉬었다면 앱이 뒤에서 느려졌다는 뜻
  const slowGap = t.gapMs > (delayMax + 1) * 1000
  const rows: [string, string, string][] = [
    ['보내기 + 서버가 그리는 시간', sec(t.waitMs), `요청 크기 ${mb(t.sentBytes)}`],
    ['결과 내려받기', sec(t.downloadMs), `받은 크기 ${mb(t.receivedBytes)}`],
    ['기기에 저장', sec(t.processMs), '간격과 겹쳐서 진행'],
    ['다음 장까지 쉰 시간', t.gapMs ? sec(t.gapMs) : '-', slowGap ? '설정보다 김 — 앱이 뒤에서 느려짐' : '']
  ]
  return (
    <div className="my-2 rounded-lg border border-line bg-field p-2.5 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-dim">지난 배치 속도 ({t.count}장)</span>
        <span className="font-mono text-sm text-fg">장당 {sec(t.perImageMs)}</span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {rows.map(([label, value, note]) => (
          <li key={label} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-dim">{label}</span>
            {note && <span className={note.startsWith('설정보다') ? 'text-danger' : 'text-dim'}>{note}</span>}
            <span className="w-12 shrink-0 text-right font-mono tabular-nums text-fg">{value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function UpdateGroup(): ReactNode {
  const s = useSettings()
  const u = useUpdate()
  const generating = useGeneration((g) => g.running)
  const [showToken, setShowToken] = useState(false)
  const newer = u.info !== null && u.info.build > CURRENT_BUILD
  const busy = u.status === 'checking' || u.status === 'downloading'
  return (
    <Group title="앱 업데이트">
      <Row
        label={`NAIP ${__APP_VERSION__}${CURRENT_BUILD ? ` (빌드 ${CURRENT_BUILD})` : ' (직접 설치한 빌드)'}`}
        hint={
          u.status === 'checking'
            ? '확인하는 중…'
            : newer
              ? `새 버전이 있습니다: ${u.info!.title}`
              : u.status === 'latest'
                ? '최신 버전입니다'
                : '앱을 열 때마다 자동으로 확인합니다'
        }
      >
        <Button disabled={busy} onClick={() => void u.check()}>
          업데이트 확인
        </Button>
      </Row>
      {u.error && (
        <p role="alert" className="mb-2 rounded-md bg-danger/15 px-2.5 py-1.5 text-xs text-danger">
          {u.error}
        </p>
      )}
      {newer && (
        <div className="mb-2 rounded-lg border border-accent bg-accent/10 p-2.5">
          {u.info!.notes && (
            <p className="mb-2 line-clamp-6 whitespace-pre-wrap break-words text-xs text-fg">{u.info!.notes}</p>
          )}
          <Button
            variant="primary"
            className="w-full"
            disabled={busy || generating}
            onClick={() => void u.install()}
          >
            {u.status === 'downloading'
              ? `내려받는 중 ${u.progress === null ? '…' : `${Math.round(u.progress * 100)}%`}`
              : `내려받아 설치 (${(u.info!.size / 1048576).toFixed(1)}MB)`}
          </Button>
          <p className="mt-1.5 text-[11px] text-dim">
            {generating
              ? '생성이 끝난 뒤 설치할 수 있습니다.'
              : '내려받은 뒤 뜨는 설치 화면에서 "업데이트"를 누르면 됩니다. 처음 한 번은 "이 출처 허용"을 켜야 합니다. 데이터는 그대로 유지됩니다.'}
          </p>
        </div>
      )}
      <details className="pb-2 text-xs text-dim">
        <summary className="cursor-pointer py-1.5">저장소 · 비공개 저장소용 토큰</summary>
        <label className="mt-1 flex flex-col gap-1">
          GitHub 저장소 (소유자/이름)
          <TextInput label="GitHub 저장소" value={s.updateRepo} onChange={(updateRepo) => s.patch({ updateRepo })} className="font-mono" />
        </label>
        <label className="mt-2 flex flex-col gap-1">
          GitHub 토큰 — 저장소가 비공개일 때만 필요합니다
          <span className="flex gap-1.5">
            <TextInput
              label="GitHub 토큰"
              type={showToken ? 'text' : 'password'}
              value={s.githubToken}
              onChange={(githubToken) => s.setGithubToken(githubToken)}
              placeholder="github_pat_..."
              className="font-mono"
            />
            <IconButton label={showToken ? '토큰 숨기기' : '토큰 보기'} onClick={() => setShowToken(!showToken)} className="h-11 w-11">
              {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
            </IconButton>
          </span>
        </label>
        <p className="mt-1.5 leading-relaxed">
          GitHub → Settings → Developer settings → Fine-grained tokens 에서 이 저장소만 고르고 Contents 권한을
          "Read-only"로 준 토큰을 만들어 넣으세요. 토큰은 이 기기에만 저장되고 GitHub에만 보냅니다.
        </p>
      </details>
    </Group>
  )
}

function exportBackup(): void {
  const p = usePrompt.getState()
  const c = useCharacters.getState()
  const f = useFragments.getState()
  const sc = useScenes.getState()
  const data = {
    app: 'naip',
    version: 2,
    fragments: { folders: f.folders, fragments: f.fragments },
    scenes: { folders: sc.folders, scenes: sc.scenes },
    prompt: {
      base: p.base,
      additional: p.additional,
      detail: p.detail,
      negative: p.negative,
      params: p.params,
      presets: p.presets
    },
    characters: { folders: c.folders, characters: c.characters, cast: c.cast }
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const stamp = new Date().toISOString().slice(0, 10)
  void shareFile(blob, `naip-backup-${stamp}.json`).catch((e: Error) => window.alert(e.message))
}

function importBackup(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    void file.text().then((text) => {
      try {
        const data = JSON.parse(text) as {
          app?: string
          prompt?: Record<string, unknown>
          characters?: Record<string, unknown>
          fragments?: Record<string, unknown>
          scenes?: Record<string, unknown>
        }
        if (data.app !== 'naip' || !data.prompt || !data.characters) {
          throw new Error('NAIP 백업 파일이 아닙니다')
        }
        if (!window.confirm('현재 프롬프트·프리셋·캐릭터·조각·씬을 백업 내용으로 덮어쓸까요?')) return
        usePrompt.setState(data.prompt)
        useCharacters.setState(data.characters)
        if (data.fragments) useFragments.setState(data.fragments)
        if (data.scenes) useScenes.setState(data.scenes)
        window.alert('백업을 불러왔습니다')
      } catch (e) {
        window.alert(`불러오기 실패: ${(e as Error).message}`)
      }
    })
  }
  input.click()
}

export function SettingsPane(): ReactNode {
  const s = useSettings()
  const history = useHistory()
  const [draft, setDraft] = useState(s.token)
  // 토큰은 암호화 저장소에서 늦게 읽혀 올 수 있다 — 아직 아무것도 안 적었으면 채워 넣는다
  useEffect(() => {
    if (s.secretsLoaded && !draft && s.token) setDraft(s.token)
  }, [s.secretsLoaded, s.token]) // eslint-disable-line react-hooks/exhaustive-deps
  const [show, setShow] = useState(false)
  const [checking, setChecking] = useState(false)
  const anlas = anlasOf(s.subscription)

  const verify = (): void => {
    s.setToken(draft)
    setChecking(true)
    void useSettings
      .getState()
      .refreshSubscription()
      .finally(() => setChecking(false))
  }

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-3 p-3">
        <Group title="NovelAI 계정">
          <p className="pb-2 text-xs text-dim">
            NovelAI 웹 → 설정 → Account → Get Persistent API Token 에서 발급한 토큰(pst-…)을
            붙여 넣으세요. 토큰은 이 기기에만 저장됩니다.
          </p>
          <div className="flex gap-1.5">
            <TextInput
              label="API 토큰"
              type={show ? 'text' : 'password'}
              value={draft}
              onChange={setDraft}
              placeholder="pst-..."
              className="font-mono"
            />
            <IconButton label={show ? '토큰 숨기기' : '토큰 보기'} onClick={() => setShow(!show)} className="h-11 w-11">
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </IconButton>
            <Button variant="primary" disabled={checking || !draft.trim()} onClick={verify}>
              {checking ? '확인 중' : '확인'}
            </Button>
          </div>
          <p className="py-2 text-xs" role="status">
            {s.subscriptionError ? (
              <span className="text-danger">{s.subscriptionError}</span>
            ) : s.subscription ? (
              <span className="text-dim">
                {TIER_LABEL[s.subscription.tier]}
                {s.subscription.expired ? ' (만료됨)' : ''} · Anlas {anlas?.toLocaleString()}
              </span>
            ) : (
              <span className="text-dim">{s.token ? '토큰 미확인' : '토큰이 설정되지 않았습니다'}</span>
            )}
          </p>
          <V5Gauge />
        </Group>

        <Group title="대량 생성">
          <p className="pb-1 text-xs text-dim">
            여러 장을 뽑아도 서버에는 항상 1장씩 순서대로 요청합니다. 한 장이 끝날 때마다 아래 범위에서
            무작위로 고른 시간만큼 쉬었다가 다음 장을 요청합니다.
          </p>
          <SliderRow
            label="장 사이 간격 — 최소"
            value={s.delayMin}
            min={DELAY_MIN}
            max={DELAY_MAX}
            step={0.1}
            format={(v) => `${v.toFixed(1)}초`}
            onChange={(v) => s.setDelay(v, Math.max(v, s.delayMax))}
          />
          <SliderRow
            label="장 사이 간격 — 최대"
            value={s.delayMax}
            min={DELAY_MIN}
            max={DELAY_MAX}
            step={0.1}
            format={(v) => `${v.toFixed(1)}초`}
            onChange={(v) => s.setDelay(Math.min(v, s.delayMin), v)}
          />
          <Row
            label="생성 중 미리보기 (스트리밍)"
            hint="그리는 과정을 단계별로 보여 줍니다. 중간 그림은 저장되지 않습니다. 생성 도중 멈춰도 이미 시작된 장은 비용·할당량이 청구될 수 있습니다"
          >
            <Toggle label="생성 중 미리보기" checked={s.streaming} onChange={(streaming) => s.patch({ streaming })} />
          </Row>
          <SpeedReport />
          <Row label="생성 중 화면 켜 두기" hint="화면이 꺼지면 안드로이드가 생성을 멈출 수 있습니다">
            <Toggle label="생성 중 화면 켜 두기" checked={s.keepAwake} onChange={(keepAwake) => s.patch({ keepAwake })} />
          </Row>
          <Row label="백그라운드에서 계속 생성" hint="다른 앱을 쓰거나 화면을 꺼도 알림과 함께 계속 진행합니다">
            <Toggle label="백그라운드에서 계속 생성" checked={s.background} onChange={(background) => s.patch({ background })} />
          </Row>
          <Row label="완료 시 진동" hint="여러 장 생성이 끝나면 진동으로 알립니다">
            <Toggle label="완료 시 진동" checked={s.vibrate} onChange={(vibrate) => s.patch({ vibrate })} />
          </Row>
        </Group>

        <Group title="프롬프트 입력">
          <Row label="태그 자동완성" hint="입력 중인 태그를 정확도 순으로 제안합니다. 한국어로도 찾을 수 있습니다">
            <Select
              label="태그 자동완성"
              className="w-40"
              value={s.tagSource}
              options={[
                { value: 'both', label: '단부루 + e621' },
                { value: 'danbooru', label: '단부루만' },
                { value: 'e621', label: 'e621만' },
                { value: 'off', label: '끄기' }
              ]}
              onChange={(tagSource) => s.patch({ tagSource })}
            />
          </Row>
          <TagUsageRow />
          <p className="pb-2 text-xs text-dim">
            가중치 색상: <span className="rounded px-1" style={{ background: 'color-mix(in srgb, var(--mark-up) 40%, transparent)' }}>강조 1.2::…::, {'{…}'}</span>{' '}
            <span className="rounded px-1" style={{ background: 'color-mix(in srgb, var(--mark-down) 40%, transparent)' }}>약화 0.7::…::, […]</span>{' '}
            <span className="rounded px-1" style={{ background: 'color-mix(in srgb, var(--mark-negative) 40%, transparent)' }}>음수 -1::…::</span>{' '}
            <span className="rounded px-1" style={{ background: 'color-mix(in srgb, var(--mark-fragment) 30%, transparent)' }}>{'<조각>'}</span>
          </p>
        </Group>

        <Group title="저장">
          <Row label="갤러리에 자동 저장" hint="생성될 때마다 Pictures/NAIP 폴더에 저장">
            <Toggle label="갤러리에 자동 저장" checked={s.autoSave} onChange={(autoSave) => s.patch({ autoSave })} />
          </Row>
          <Row label="씬별 폴더로 나눠 저장" hint="씬으로 만든 이미지는 Pictures/NAIP/씬 이름 에 저장">
            <Toggle label="씬별 폴더로 나눠 저장" checked={s.sceneFolders} onChange={(sceneFolders) => s.patch({ sceneFolders })} />
          </Row>
          <Row
            label="복사·공유할 때 메타데이터 지우기"
            hint="클립보드 복사와 공유로 내보내는 그림에서 프롬프트·시드 등 생성 정보를 지웁니다 (앱 안의 기록은 그대로)"
          >
            <Toggle
              label="복사·공유할 때 메타데이터 지우기"
              checked={s.shareStripMeta}
              onChange={(shareStripMeta) => s.patch({ shareStripMeta })}
            />
          </Row>
          <Row label="히스토리 보관 한도" hint="넘으면 즐겨찾기를 뺀 오래된 이미지부터 앱에서 지웁니다">
            <Select
              label="히스토리 보관 한도"
              className="w-36"
              value={s.historyLimit}
              options={LIMITS}
              onChange={(historyLimit) => s.patch({ historyLimit })}
            />
          </Row>
        </Group>

        <UpdateGroup />

        <Group title="데이터">
          <Row label="백업" hint="프롬프트·프리셋·캐릭터·조각·씬을 JSON 파일로 내보내거나 불러옵니다">
            <div className="flex gap-1.5">
              <Button onClick={exportBackup}>내보내기</Button>
              <Button onClick={importBackup}>불러오기</Button>
            </div>
          </Row>
          <Row label="히스토리 비우기" hint={`앱 안에 보관 중인 이미지 ${history.total}장 (갤러리에 저장한 파일은 남습니다)`}>
            <Button
              variant="danger"
              disabled={!history.total}
              onClick={() => {
                if (window.confirm(`히스토리의 이미지 ${history.total}장을 모두 삭제할까요? 되돌릴 수 없습니다.`))
                  void history.clear()
              }}
            >
              모두 삭제
            </Button>
          </Row>
        </Group>

        <p className="px-1 pb-4 text-[11px] leading-relaxed text-dim">
          NAIP {__APP_VERSION__}
          {CURRENT_BUILD ? ` (빌드 ${CURRENT_BUILD})` : ''} · NAIS3(sunanakgo) 기반 · GPL-3.0. NovelAI와 무관한 비공식 개인용
          클라이언트입니다.
        </p>
      </div>
    </div>
  )
}
