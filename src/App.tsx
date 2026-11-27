import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDownToLine, Clapperboard, Coins, History, Image as ImageIcon, PenLine, Settings, X } from 'lucide-react'
import { App as CapApp } from '@capacitor/app'
import { closeTop } from './lib/back'
import { isNative, onStopRequested } from './lib/native'
import { cx } from './lib/util'
import { estimateCurrent, useGeneration } from './stores/generation'
import { useHistory } from './stores/history'
import { usePrompt } from './stores/prompt'
import { useRefs } from './stores/refs'
import { anlasOf, useSettings } from './stores/settings'
import { useSource } from './stores/source'
import { useDirector } from './stores/director'
import { useImporter } from './stores/importer'
import { useSaver } from './stores/saver'
import { CURRENT_BUILD, useUpdate } from './stores/update'
import { SaveSheet } from './components/SaveSheet'
import { ImportSheet } from './components/ImportSheet'
import { CharacterSheet } from './components/CharacterSheet'
import { DirectorSheet } from './components/DirectorSheet'
import { FragmentSheet } from './components/FragmentSheet'
import { ScenePane } from './components/ScenePane'
import { GenerateBar } from './components/GenerateBar'
import { ImageViewer } from './components/ImageViewer'
import { HistoryPane, PreviewPane } from './components/Panes'
import { ParamsSheet } from './components/ParamsSheet'
import { PresetSheet } from './components/PresetSheet'
import { PromptPanel, type SheetName } from './components/PromptPanel'
import { CharRefSheet, VibeSheet } from './components/RefSheets'
import { SettingsPane } from './components/SettingsPane'
import { SourceSheet } from './components/SourceSheet'
import { V5Gauge } from './components/V5Gauge'
import { Toast } from './components/Toast'
import { StorageScreens } from './components/StorageScreens'
import { useStorageBoot } from './stores/storage'

type Tab = 'prompt' | 'scenes' | 'result' | 'history' | 'settings'

const TABS: { id: Tab; label: string; icon: typeof PenLine }[] = [
  { id: 'prompt', label: '프롬프트', icon: PenLine },
  { id: 'scenes', label: '씬', icon: Clapperboard },
  { id: 'result', label: '결과', icon: ImageIcon },
  { id: 'history', label: '히스토리', icon: History },
  { id: 'settings', label: '설정', icon: Settings }
]

function useWide(): boolean {
  const query = '(min-width: 900px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = (): void => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/** 보유 Anlas와 이번 배치의 예상 사용량 */
function AnlasChip(): ReactNode {
  const { subscription, token, refreshSubscription } = useSettings()
  // 예상치에 영향을 주는 상태를 구독해 다시 계산한다
  usePrompt()
  useRefs()
  useSource()
  const anlas = anlasOf(subscription)
  const est = estimateCurrent()
  return (
    <button
      type="button"
      title="보유 Anlas / 예상 사용 Anlas — 눌러서 새로고침"
      onClick={() => void refreshSubscription()}
      className="flex h-9 items-center gap-2 rounded-full border border-line bg-field px-3 font-mono text-xs tabular-nums"
    >
      <Coins size={14} className="text-accent" />
      <span>{anlas === null ? (token ? '…' : '토큰 없음') : anlas.toLocaleString()}</span>
      <span
        className={cx(
          'rounded px-1.5 py-0.5',
          est.total > 0 ? 'bg-danger/20 text-danger' : 'bg-raised text-dim'
        )}
      >
        {est.total > 0 ? `-${est.total}` : est.usesOpusUsage ? 'V5 게이지' : '무료'}
      </span>
    </button>
  )
}

/** 새 빌드가 있으면 화면 위에 띄우는 한 줄 — 버튼 하나로 내려받아 설치 화면까지 간다 */
function UpdateBanner(): ReactNode {
  const u = useUpdate()
  const generating = useGeneration((s) => s.running)
  if (!u.info || u.info.build <= CURRENT_BUILD || u.dismissed) return null
  const downloading = u.status === 'downloading'
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent/15 py-1.5 pl-3 pr-1 text-xs">
      <span className="min-w-0 flex-1 truncate">
        {u.status === 'error' ? (u.error ?? '업데이트 실패') : `새 버전이 있습니다 · ${u.info.title}`}
      </span>
      <button
        type="button"
        disabled={downloading || generating}
        onClick={() => void u.install()}
        className="flex h-9 shrink-0 items-center gap-1 rounded-lg bg-accent px-3 font-semibold text-accent-fg"
      >
        <ArrowDownToLine size={14} />
        {downloading
          ? `${u.progress === null ? '…' : `${Math.round(u.progress * 100)}%`}`
          : generating
            ? '생성 후 가능'
            : u.status === 'error'
              ? '다시 시도'
              : '업데이트'}
      </button>
      <button type="button" aria-label="업데이트 알림 닫기" disabled={downloading} onClick={u.dismiss} className="flex h-9 w-9 shrink-0 items-center justify-center text-dim">
        <X size={16} />
      </button>
    </div>
  )
}

export default function App(): ReactNode {
  const wide = useWide()
  const [tab, setTab] = useState<Tab>('prompt')
  const [sheet, setSheet] = useState<SheetName | null>(null)
  const viewing = useHistory((s) => s.viewing)
  const running = useGeneration((s) => s.running)
  const directorOpen = useDirector((s) => s.open)
  const importing = useImporter((s) => s.data !== null)
  const saving = useSaver((s) => s.items !== null)
  const shown: Tab = wide && tab === 'prompt' ? 'result' : tab

  useEffect(() => {
    // 저장소 열기 → (처음 한 번) 예전 히스토리 옮기기 → 히스토리 불러오기 → 끝나지 않은 생성 묻기
    void useStorageBoot.getState().boot()
    // 토큰을 암호화 저장소에서 읽은 뒤에 계정 정보와 새 빌드를 확인한다 (비공개 저장소면 GitHub 토큰이 필요)
    void useSettings
      .getState()
      .loadSecrets()
      .catch(() => useSettings.setState({ secretsLoaded: true }))
      .finally(() => {
        void useSettings.getState().refreshSubscription()
        void useUpdate.getState().check(true)
      })
    // 진행 알림의 "중지" — 지금 배치와 대기열을 모두 멈춘다
    return onStopRequested(() => useGeneration.getState().stop())
  }, [])

  // 생성을 시작하면 좁은 화면에서는 결과 탭으로 넘어가 진행을 보여 준다
  useEffect(() => {
    if (running) setTab((t) => (t === 'prompt' || t === 'scenes' ? 'result' : t))
  }, [running])

  // 다른 화면에서 탭 전환을 요청할 때 (예: 씬 카드의 "이미지 보기")
  useEffect(() => {
    const on = (e: Event): void => setTab((e as CustomEvent<Tab>).detail)
    window.addEventListener('naip:tab', on)
    return () => window.removeEventListener('naip:tab', on)
  }, [])

  useEffect(() => {
    if (!isNative) return
    const sub = CapApp.addListener('backButton', () => {
      if (closeTop()) return
      if (useGeneration.getState().running) void CapApp.minimizeApp()
      else void CapApp.exitApp()
    })
    return () => void sub.then((h) => h.remove())
  }, [])

  const bar = <GenerateBar openParams={() => setSheet('params')} />

  return (
    <div className="safe-top flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <h1 className="text-base font-bold tracking-tight">NAIP</h1>
        <AnlasChip />
        {wide && (
          <nav className="ml-auto flex gap-1" aria-label="화면">
            {TABS.filter((t) => t.id !== 'prompt').map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={shown === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
                className={cx(
                  'flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px]',
                  shown === t.id ? 'bg-raised text-fg' : 'text-dim hover:text-fg'
                )}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </nav>
        )}
      </header>
      <V5Gauge compact />
      <UpdateBanner />

      <div className="flex min-h-0 flex-1">
        {(wide || shown === 'prompt') && (
          <aside
            className={cx(
              'flex min-h-0 flex-col bg-panel',
              wide ? 'w-[400px] shrink-0 border-r border-line' : 'flex-1'
            )}
          >
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              <PromptPanel open={setSheet} />
            </div>
            {bar}
          </aside>
        )}
        {shown !== 'prompt' && (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {shown === 'scenes' && (
              <ScenePane
                bar={(ids, count, cost) => (
                  <GenerateBar openParams={() => setSheet('params')} scene={{ ids, count, cost }} />
                )}
              />
            )}
            {shown === 'result' && <PreviewPane />}
            {shown === 'history' && <HistoryPane />}
            {shown === 'settings' && <SettingsPane />}
            {!wide && shown === 'result' && bar}
          </main>
        )}
      </div>

      {!wide && (
        <nav className="safe-bottom shrink-0 border-t border-line bg-panel" aria-label="화면">
          <div className="flex">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={shown === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
                className={cx(
                  'flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px]',
                  shown === t.id ? 'text-accent' : 'text-dim'
                )}
              >
                <t.icon size={20} />
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      {sheet === 'characters' && <CharacterSheet onClose={() => setSheet(null)} />}
      {sheet === 'source' && <SourceSheet onClose={() => setSheet(null)} />}
      {sheet === 'vibes' && <VibeSheet onClose={() => setSheet(null)} />}
      {sheet === 'refs' && <CharRefSheet onClose={() => setSheet(null)} />}
      {sheet === 'params' && <ParamsSheet onClose={() => setSheet(null)} />}
      {sheet === 'presets' && <PresetSheet onClose={() => setSheet(null)} />}
      {sheet === 'fragments' && <FragmentSheet onClose={() => setSheet(null)} />}
      {directorOpen && <DirectorSheet />}
      {importing && <ImportSheet />}
      {viewing !== null && (
        <ImageViewer
          onUseSource={() => {
            setTab('prompt')
            setSheet('source')
          }}
        />
      )}
      {saving && <SaveSheet />}
      <StorageScreens />
      <Toast />
    </div>
  )
}
