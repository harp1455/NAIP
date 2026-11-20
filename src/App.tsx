import { useEffect, useState, type ReactNode } from 'react'
import { Coins, History, Image as ImageIcon, PenLine, Settings } from 'lucide-react'
import { App as CapApp } from '@capacitor/app'
import { closeTop } from './lib/back'
import { isNative } from './lib/native'
import { cx } from './lib/util'
import { estimateCurrent, useGeneration } from './stores/generation'
import { useHistory } from './stores/history'
import { usePrompt } from './stores/prompt'
import { useRefs } from './stores/refs'
import { anlasOf, useSettings } from './stores/settings'
import { useSource } from './stores/source'
import { CharacterSheet } from './components/CharacterSheet'
import { GenerateBar } from './components/GenerateBar'
import { ImageViewer } from './components/ImageViewer'
import { HistoryPane, PreviewPane } from './components/Panes'
import { ParamsSheet } from './components/ParamsSheet'
import { PresetSheet } from './components/PresetSheet'
import { PromptPanel, type SheetName } from './components/PromptPanel'
import { CharRefSheet, VibeSheet } from './components/RefSheets'
import { SettingsPane } from './components/SettingsPane'
import { SourceSheet } from './components/SourceSheet'

type Tab = 'prompt' | 'result' | 'history' | 'settings'

const TABS: { id: Tab; label: string; icon: typeof PenLine }[] = [
  { id: 'prompt', label: '프롬프트', icon: PenLine },
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

export default function App(): ReactNode {
  const wide = useWide()
  const [tab, setTab] = useState<Tab>('prompt')
  const [sheet, setSheet] = useState<SheetName | null>(null)
  const viewing = useHistory((s) => s.viewing)
  const running = useGeneration((s) => s.running)
  const shown: Tab = wide && tab === 'prompt' ? 'result' : tab

  useEffect(() => {
    void useHistory.getState().init()
    void useSettings.getState().refreshSubscription()
  }, [])

  // 생성을 시작하면 좁은 화면에서는 결과 탭으로 넘어가 진행을 보여 준다
  useEffect(() => {
    if (running) setTab((t) => (t === 'prompt' ? 'result' : t))
  }, [running])

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
      {viewing !== null && (
        <ImageViewer
          onUseSource={() => {
            setTab('prompt')
            setSheet('source')
          }}
        />
      )}
    </div>
  )
}
