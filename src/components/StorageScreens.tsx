import { useState, type ReactNode } from 'react'
import { DatabaseZap, HardDrive, TriangleAlert } from 'lucide-react'
import { formatBytes } from '../storage'
import { useGeneration } from '../stores/generation'
import { discardResume } from '../stores/queue-persist'
import { useStorageBoot } from '../stores/storage'
import { Button, Sheet, Toggle } from './ui'

/** 예전 히스토리 옮기기 화면 (진행·공간 부족·실패) */
function MigrationOverlay(): ReactNode {
  const { phase, progress, result, error, migrate, later } = useStorageBoot()
  if (phase !== 'migrating' && phase !== 'nospace' && phase !== 'failed' && phase !== 'error') return null
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div className="safe-top fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="히스토리 옮기기">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-4">
        {phase === 'migrating' && (
          <>
            <div className="flex items-center gap-2">
              <DatabaseZap size={20} className="text-accent" />
              <h2 className="text-base font-semibold">히스토리를 새 저장소로 옮기는 중</h2>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-dim">
              히스토리를 더 빠르게 열 수 있도록 저장 방식을 바꿉니다. 처음 한 번만 합니다. 앱을 닫아도 다음에 열 때
              이어서 하며, 모두 옮기고 확인을 마친 뒤에만 예전 데이터를 지웁니다.
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 flex justify-between font-mono text-xs text-dim" role="status">
              <span>
                {progress?.phase === 'verify' ? '확인하는 중…' : progress?.phase === 'clean' ? '정리하는 중…' : `${(progress?.done ?? 0).toLocaleString()} / ${(progress?.total ?? 0).toLocaleString()}장`}
              </span>
              <span>{progress ? formatBytes(progress.bytes) : ''}</span>
            </p>
          </>
        )}
        {phase === 'nospace' && result?.status === 'nospace' && (
          <>
            <div className="flex items-center gap-2">
              <HardDrive size={20} className="text-danger" />
              <h2 className="text-base font-semibold">저장 공간이 부족합니다</h2>
            </div>
            <p className="mt-2 text-sm leading-relaxed">
              히스토리를 옮기려면 약 <b>{formatBytes(result.need)}</b>가 필요한데 <b>{formatBytes(result.free)}</b>만 남았습니다.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-dim">
              옮기는 동안에는 예전 데이터와 새 데이터가 함께 있어야 해서 히스토리 크기만큼 빈 공간이 더 필요합니다. 휴대폰의
              다른 파일을 정리한 뒤 다시 확인해 주세요. 지금까지 옮긴 {result.done.toLocaleString()}/{result.total.toLocaleString()}장은
              그대로 두고, 예전 데이터도 지우지 않았습니다.
            </p>
            <div className="mt-3 flex gap-2">
              <Button onClick={later}>나중에</Button>
              <Button variant="primary" className="flex-1" onClick={() => void migrate()}>
                다시 확인
              </Button>
            </div>
          </>
        )}
        {(phase === 'failed' || phase === 'error') && (
          <>
            <div className="flex items-center gap-2">
              <TriangleAlert size={20} className="text-danger" />
              <h2 className="text-base font-semibold">{phase === 'error' ? '저장소를 열지 못했습니다' : '히스토리를 다 옮기지 못했습니다'}</h2>
            </div>
            <p className="mt-2 break-words text-xs text-danger">{error ?? (result?.status === 'failed' ? result.error : '')}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-dim">
              예전 데이터는 지우지 않았습니다. 다시 시도하면 옮기지 못한 장부터 이어서 합니다.
            </p>
            <div className="mt-3 flex gap-2">
              {phase === 'failed' && <Button onClick={later}>나중에</Button>}
              <Button
                variant="primary"
                className="flex-1"
                onClick={() => void (phase === 'error' ? useStorageBoot.getState().boot() : migrate())}
              >
                다시 시도
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 지난 실행에서 끝나지 않은 생성 — 이어서 할지, 버릴지 */
function ResumeSheet(): ReactNode {
  const { phase, resume, closeResume } = useStorageBoot()
  const [withUncertain, setWithUncertain] = useState(false)
  const [busy, setBusy] = useState(false)
  if (phase !== 'ready' || !resume?.length) return null
  const remaining = resume.reduce((a, e) => a + e.remaining.length, 0)
  const uncertain = resume.reduce((a, e) => a + e.uncertain.length, 0)
  const sending = remaining + (withUncertain ? uncertain : 0)
  return (
    <Sheet
      title="끝나지 않은 생성"
      onClose={closeResume}
      footer={
        <>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('끝나지 않은 생성을 버릴까요? 보내지 않은 씬 장은 씬 예약으로 돌아갑니다.')) return
              setBusy(true)
              void discardResume(resume).finally(closeResume)
            }}
          >
            버리기
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={busy || sending === 0}
            onClick={() => {
              setBusy(true)
              closeResume()
              void useGeneration.getState().resume(resume, withUncertain)
            }}
          >
            {sending ? `이어서 생성 (${sending}장)` : '이어서 보낼 장 없음'}
          </Button>
        </>
      }
    >
      <p className="text-sm">앱이 닫히기 전에 끝나지 않은 생성이 있습니다. 보내지 않은 장부터 이어서 생성할 수 있습니다.</p>
      <ul className="mt-3 flex flex-col gap-2">
        {resume.map((e) => (
          <li key={e.batch.id} className="rounded-lg border border-line bg-field p-2.5 text-xs">
            <p className="truncate text-sm text-fg">{e.batch.label}</p>
            <p className="mt-1 text-dim">
              완료 {e.done}장 · 남은 장 {e.remaining.length}장{e.failed ? ` · 실패 ${e.failed}장` : ''} / 전체 {e.total}장
            </p>
            {e.uncertain.length > 0 && (
              <p className="mt-1 text-danger" data-testid="uncertain">
                확인 필요 {e.uncertain.length}장
                {e.uncertain.some((u) => u.seed !== null) ? ` (seed ${e.uncertain.map((u) => u.seed).filter((x) => x !== null).join(', ')})` : ''}
              </p>
            )}
          </li>
        ))}
      </ul>
      {uncertain > 0 && (
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-xs leading-relaxed">
          <p>
            <b>확인 필요 {uncertain}장</b>은 요청을 보낸 뒤 결과를 받기 전에 앱이 닫혔습니다. 서버가 이미 그려서 Anlas·할당량이 쓰였을
            수 있어 자동으로 다시 보내지 않습니다. 히스토리에 그 그림이 없다면 받지 못한 것입니다.
          </p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span>확인 필요 장도 다시 요청</span>
            <Toggle label="확인 필요 장도 다시 요청" checked={withUncertain} onChange={setWithUncertain} />
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-dim">닫으면 다음에 앱을 열 때 다시 묻습니다.</p>
    </Sheet>
  )
}

/** 앱 전체에 한 번 놓는다 */
export function StorageScreens(): ReactNode {
  return (
    <>
      <MigrationOverlay />
      <ResumeSheet />
    </>
  )
}
