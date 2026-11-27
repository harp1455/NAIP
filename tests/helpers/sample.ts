/** 시험용 NAIP 데이터 — 모든 섹션을 채운다 (그림은 작은 PNG) */
import type { HistoryExportPort, HistoryImportPort, HistoryRecord } from '../../src/backup/history'
import type { BackupData } from '../../src/backup/types'

/** 1×1 PNG */
export const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
export const NAI_TOKEN = 'pst-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'
export const GH_TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'

export const PARAMS = {
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  qualityToggle: true,
  ucPreset: 0
}

export function sampleData(): BackupData {
  return {
    settings: {
      token: NAI_TOKEN,
      githubToken: GH_TOKEN,
      delayMin: 1.1,
      delayMax: 1.3,
      autoSave: false,
      historyLimit: 500,
      tagSource: 'both',
      updateRepo: 'owner/repo',
      streaming: true,
      nested: { apiKey: 'k-123', label: 'ok', note: NAI_TOKEN }
    },
    saveFolders: { saveFolders: ['a', 'b'], saveFolder: 'a', nameMode: 'auto', nameCounters: { 'a/alice': 3 } },
    prompt: { base: 'masterpiece', additional: '1girl', detail: 'smile', negative: 'lowres', params: PARAMS, seed: '', count: 4, activePresetId: 11 },
    presets: {
      presets: [
        { id: 11, name: '기본', base: 'masterpiece', detail: 'smile', negative: 'lowres', params: PARAMS },
        { id: 12, name: 'V5', base: 'x', detail: '', negative: '', params: { ...PARAMS, model: 'nai-diffusion-5-full' } }
      ]
    },
    characters: {
      folders: [{ id: 21, name: '주인공' }],
      characters: [
        { id: 31, name: 'Alice', folderId: 21, prompt: '1girl', negative: '' },
        { id: 32, name: 'Bob', folderId: null, prompt: '1boy', negative: 'bad', variations: [{ id: 1, name: '정장' }] }
      ],
      cast: [
        { charId: 32, enabled: true, center: { x: 0.3, y: 0.5 } },
        { charId: 31, enabled: true, center: null }
      ],
      slots: { opaque: true }
    },
    scenes: {
      folders: [{ id: 41, name: '야외' }],
      scenes: [
        { id: 51, name: '해변', folderId: 41, prompt: 'beach', negative: '', size: null, cast: [31, 32], castCenters: { 31: { x: 0.2, y: 0.5 } }, reserve: 2 },
        { id: 52, name: '숲', folderId: 41, prompt: 'forest', negative: '', size: { width: 1024, height: 1024 }, reserve: 0 },
        { id: 53, name: '방', folderId: null, prompt: 'room', negative: 'x', size: null, reserve: 1 }
      ]
    },
    fragments: {
      folders: [{ id: 61, name: '포즈' }],
      fragments: [
        { id: 71, name: 'pose', folderId: 61, content: 'standing\nsitting' },
        { id: 72, name: 'pose', folderId: null, content: 'lying' }
      ]
    },
    vibes: {
      vibes: [
        { id: 81, name: '수채화', image: PNG_1X1, thumb: `data:image/jpeg;base64,${PNG_1X1}`, strength: 0.6, infoExtracted: 1, enabled: true, encodings: { 'nai-diffusion-4-5-full|1': 'ENC1', 'nai-diffusion-4-5-full|0.7': 'ENC07' } },
        { id: 82, name: '복원', image: '', thumb: '', strength: 0.4, infoExtracted: 1, enabled: false, encodings: { 'nai-diffusion-4-5-curated|1': 'ENC2' } }
      ]
    },
    charRefs: {
      charRefs: [
        { id: 91, name: '의상', image: PNG_1X1, thumb: '', type: 'costume', strength: 2, fidelity: 1, enabled: true },
        { id: 92, name: '캐릭터', image: PNG_1X1, thumb: '', type: 'character', sameOutfit: true, strength: 1, fidelity: 0.8, enabled: false }
      ]
    },
    tagUsage: {
      entries: {
        '1girl': { hit: { tag: '1girl', category: 'g', counts: { danbooru: 1 } }, n: 3, last: 100 },
        secret: { hit: { tag: 'secret', category: 'g', counts: {} }, n: 1, last: 50 },
        token: { hit: { tag: 'token', category: 'g', counts: {} }, n: 1, last: 60 }
      }
    },
    masks: { masks: [{ id: 101, name: '얼굴', width: 8, height: 8, data: `data:image/png;base64,${PNG_1X1}`, ts: 5 }] },
    collections: { lists: [{ id: 1, name: '좋은 것', imageIds: [1001] }] },
    exportTemplates: { templates: [{ id: 1, pattern: '{scene}_{n}' }] },
    queue: { items: [{ id: 'q1', count: 3 }] }
  }
}

export interface FakeHistory extends HistoryExportPort, HistoryImportPort {
  records: Map<number, { record: HistoryRecord; original: Uint8Array | null }>
}

export function fakeHistory(n: number, missingOriginal?: number): FakeHistory {
  const records = new Map<number, { record: HistoryRecord; original: Uint8Array | null }>()
  for (let i = 1; i <= n; i++) {
    const id = 1_700_000_000_000 + i
    const bytes = new Uint8Array(1000 + i).map((_, j) => (j * 7 + i) & 0xff)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    records.set(id, {
      record: { id, ts: id, mime: 'image/png', prompt: `p${i}`, seed: i, thumb: `data:image/jpeg;base64,${PNG_1X1}`, ...(i % 2 ? { fav: 1 } : {}) },
      original: i === missingOriginal ? null : bytes
    })
  }
  return {
    records,
    async stats() {
      return { count: records.size, originalBytes: [...records.values()].reduce((s, r) => s + (r.original?.byteLength ?? 0), 0) }
    },
    async *pages(size) {
      const all = [...records.values()].map((r) => r.record)
      for (let i = 0; i < all.length; i += size) yield all.slice(i, i + size)
    },
    async original(record) {
      return records.get(record.id)?.original ?? null
    },
    async existingIds(ids) {
      return new Set(ids.filter((id) => records.has(id)))
    },
    async clear() {
      records.clear()
    },
    async put(record, original) {
      records.set(record.id, { record, original })
    }
  }
}
