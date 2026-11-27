import type { HistoryMeta } from '../lib/db'
import { insertStatements } from './history-repo'
import type { Storage } from './index'

/**
 * 브라우저 개발 빌드 전용 (주소에 ?naipdev): 성능 측정용 가짜 히스토리를 만든다.
 * 휴대폰 빌드에서는 불리지 않는다.
 */
const TAGS = (
  '1girl,solo,long hair,short hair,blue eyes,red eyes,blonde hair,black hair,smile,open mouth,looking at viewer,' +
  'school uniform,dress,hat,outdoors,indoors,beach,city,night,day,sky,cloud,flower,cat ears,twintails,ponytail,' +
  'holding,sitting,standing,upper body,full body,from side,from above,blush,closed eyes,hand up,jacket,skirt,' +
  'thighhighs,boots,glasses,ribbon,bow,scarf,umbrella,rain,snow,sunset,forest,classroom,cafe,library,ocean'
).split(',')
const SCENES = ['바다', '도시', '숲', '교실', '카페', '도서관', '눈길', '노을', '밤거리', '비 오는 날']

function rand(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

async function canvasBlob(w: number, h: number, type: string): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#5b7cfa')
  g.addColorStop(1, '#f59e0b')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  return new Promise((resolve) => c.toBlob((b) => resolve(b!), type, 0.8))
}

export function installDevHooks(s: Storage): void {
  const hooks = {
    storage: s,
    /** n장짜리 가짜 히스토리 (썸네일·원본 파일은 한 장을 같이 쓴다) */
    async seed(n: number, startId = 1_600_000_000_000): Promise<number> {
      const t0 = performance.now()
      await s.files.write('thumbs/synthetic.jpg', await canvasBlob(320, 468, 'image/jpeg'))
      const r = rand(n)
      const pick = (k: number): string => Array.from({ length: k }, () => TAGS[Math.floor(r() * TAGS.length)]).join(', ')
      for (let start = 0; start < n; start += 5000) {
        const statements = []
        for (let i = start; i < Math.min(n, start + 5000); i++) {
          const id = startId + i * 1000
          const scene = r() < 0.33 ? Math.floor(r() * SCENES.length) : -1
          const chars = r() < 0.25 ? [{ name: `캐릭터${i % 7}`, prompt: pick(6), negative: '' }] : []
          const meta: HistoryMeta = {
            id,
            ts: id,
            thumb: '',
            width: 832,
            height: 1216,
            seed: Math.floor(r() * 4294967295),
            model: r() < 0.5 ? 'nai-diffusion-4-5-full' : 'nai-diffusion-5',
            kind: r() < 0.9 ? 't2i' : 'i2i',
            prompt: `${pick(18)}, very aesthetic, masterpiece, no text`,
            negative: 'lowres, bad anatomy, ' + pick(4),
            mime: 'image/png',
            ...(scene >= 0 ? { sceneId: scene + 1, sceneName: SCENES[scene] } : {}),
            ...(i % 17 === 0 ? { fav: 1 as const } : {}),
            ...(r() < 0.5 ? { unsaved: 1 as const } : { saved: `NAIP_${i}.png` }),
            snap: { base: pick(10), additional: pick(5), detail: '', negative: 'lowres', params: { steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral' }, chars: [] },
            sent: { prompt: pick(18), negative: 'lowres', chars }
          }
          statements.push(...insertStatements(meta, `images/${id}.png`, 1_500_000, 'thumbs/synthetic.jpg'))
        }
        await s.driver.batch(statements)
      }
      return performance.now() - t0
    },
    async time<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
      const t0 = performance.now()
      const result = await fn()
      return { ms: performance.now() - t0, result }
    },
    async flush(): Promise<void> {
      await (s.driver as { flush?: () => Promise<void> }).flush?.()
    }
  }
  ;(window as unknown as { __naipDev: typeof hooks }).__naipDev = hooks
}
