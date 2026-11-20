import { useState, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { shareImage as shareFile } from '../lib/native'
import { useCharacters } from '../stores/characters'
import { useFragments } from '../stores/fragments'
import { useScenes } from '../stores/scenes'
import { useHistory } from '../stores/history'
import { usePrompt } from '../stores/prompt'
import { anlasOf, DELAY_MAX, DELAY_MIN, useSettings } from '../stores/settings'
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
          NAIP {__APP_VERSION__} · NAIS3(sunanakgo) 기반 · GPL-3.0. NovelAI와 무관한 비공식 개인용
          클라이언트입니다.
        </p>
      </div>
    </div>
  )
}
