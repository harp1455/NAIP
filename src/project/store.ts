/**
 * 에셋 프로젝트 저장소 (zustand persist, localStorage 'naip-projects').
 * 계산은 모두 순수 함수(model·curation)에 맡기고, 여기서는 프로젝트를 찾아 바꿔 끼우기만 한다.
 *
 * 생성 대기열과 연결 (리드):
 *   planJobs → 배치에 넣을 때 markQueued, 한 장 요청을 시작할 때 markStarted,
 *   히스토리에 저장되면 addImage(분류 표시 tag의 key로), 실패하면 markFailed,
 *   멈춤·대기열에서 뺄 때 못 뽑은 장수만큼 releaseQueued (여러 장이면 releaseRuntime으로 한 번에).
 *   앱을 다시 열면 대기·생성 중 장수는 0으로 돌아간다 — 대기열은 저장되지만(stores/queue-persist) 앱을 다시 열면
 *   그 배치는 돌지 않으므로, 저장된 대기열을 읽을 때(loadResume) 보내지 않은 장을 다시 대기로 센다.
 */
import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { toast } from '../stores/toast'
import { AXIS_TEMPLATES, applyAxisTemplate, type TemplateOptions } from './axis-templates'
import * as cur from './curation'
import * as model from './model'
import type {
  AssetItem,
  AxisKind,
  AxisValue,
  Axis,
  CurationMark,
  Project,
  ProjectCharacter,
  PlatformPreset,
  ProjectParams
} from './types'

type ProjectPatch = Partial<Omit<Project, 'id' | 'createdAt' | 'items'>>

interface ProjectsState {
  projects: Project[]
  activeId: string | null
  presets: PlatformPreset[]

  create: (name: string, params?: Partial<ProjectParams>) => string
  patch: (id: string, p: ProjectPatch) => void
  remove: (id: string) => void
  duplicate: (id: string) => string | null
  setActive: (id: string | null) => void

  addCharacter: (projectId: string, c: Partial<Omit<ProjectCharacter, 'id'>> & { name: string }) => string | null
  patchCharacter: (projectId: string, charId: string, p: Partial<Omit<ProjectCharacter, 'id'>>) => void
  removeCharacter: (projectId: string, charId: string) => void
  moveCharacter: (projectId: string, charId: string, dir: -1 | 1) => void

  addAxis: (projectId: string, kind: AxisKind, name?: string) => string | null
  patchAxis: (projectId: string, axisId: string, p: Partial<Omit<Axis, 'id' | 'values'>>) => void
  removeAxis: (projectId: string, axisId: string) => void
  moveAxis: (projectId: string, axisId: string, dir: -1 | 1) => void
  addValue: (projectId: string, axisId: string, v: Partial<Omit<AxisValue, 'id'>> & { label: string }) => string | null
  patchValue: (projectId: string, axisId: string, valueId: string, p: Partial<Omit<AxisValue, 'id'>>) => void
  removeValue: (projectId: string, axisId: string, valueId: string) => void
  moveValue: (projectId: string, axisId: string, valueId: string, dir: -1 | 1) => void
  /** 축 빠른 시작 세트를 넣는다 (axis-templates.applyAxisTemplate) — 넣은 축 id */
  applyAxisTemplate: (projectId: string, templateId: string, opts?: TemplateOptions) => string | null

  // ── 생성 진행 (대기열 연결)
  markQueued: (projectId: string, jobs: readonly { key: string; count: number }[]) => void
  releaseQueued: (projectId: string, key: string, count: number) => void
  /** 여러 조합의 대기·생성 중 장수를 한 번에 줄인다 (저장도 한 번) */
  releaseRuntime: (projectId: string, deltas: readonly { key: string; queued: number; generating: number }[]) => void
  markStarted: (projectId: string, key: string) => void
  /** 시작했지만 멈춰서 끝내지 못한 장 (생성 중 장수만 되돌린다 — 실패로 세지 않는다) */
  cancelStarted: (projectId: string, key: string) => void
  /** fromQueue: false = 대기열과 무관한 그림 (분류로 배정·멈춘 뒤 늦게 도착) — 대기·생성 중 장수를 건드리지 않는다 */
  addImage: (projectId: string, key: string, image: cur.NewAssetImage, opts?: { fromQueue?: boolean }) => void
  markFailed: (projectId: string, key: string) => void

  // ── 선별
  setMarks: (projectId: string, key: string, ids: number[], mark: CurationMark) => void
  setRepresentative: (projectId: string, key: string, id: number | null) => void
  replaceAdopted: (projectId: string, key: string, oldId: number, newId: number) => void
  setRedo: (projectId: string, key: string, on: boolean) => void
  setDescription: (projectId: string, key: string, imageId: number, text: string) => void

  // ── 내보내기
  setCodes: (projectId: string, codes: readonly { key: string; slot: number; code: string }[]) => void
  /**
   * onDevice: 경로가 기기의 파일 하나(갤러리) — 다른 조합에서 같은 경로를 가리키던 기록도 지운다
   * (ZIP은 내보낼 때마다 다른 파일이라 그대로 둔다)
   */
  markExported: (
    projectId: string,
    done: readonly { key: string; imageId: number; path: string; bytes?: number }[],
    counters?: Record<string, number>,
    opts?: { onDevice?: boolean }
  ) => void
  /** 히스토리에서 지운 그림을 모든 프로젝트에서 뺀다 */
  forgetImages: (historyIds: number[]) => void

  // ── 변환 프리셋 (사용자 정의만)
  savePreset: (p: Omit<PlatformPreset, 'id'> & { id?: string }) => string
  removePreset: (id: string) => void
}

let lastSaveWarning = 0

/**
 * 저장이 실패해도(저장 공간 한도 초과 등) 동작을 막지 않는다 — zustand persist는 setItem 오류를 그대로 던져,
 * 상태는 메모리에서 바뀐 채 그 동작을 부른 곳(생성 대기열의 진행 알림·선별 단추)이 오류로 멈춘다.
 * 메모리의 상태는 그대로 두고 저장하지 못했다고 알린다 (자주 띄우지 않는다)
 */
export function guardedStorage(base: StateStorage, onError: (e: unknown) => void = warnSaveFailed): StateStorage {
  return {
    getItem: (k) => base.getItem(k),
    setItem: (k, v) => {
      try {
        const r = base.setItem(k, v)
        if (r instanceof Promise) r.catch(onError)
      } catch (e) {
        onError(e)
      }
    },
    removeItem: (k) => base.removeItem(k)
  }
}

function warnSaveFailed(e: unknown): void {
  console.warn('프로젝트 기록 저장 실패', e)
  const now = Date.now()
  if (now - lastSaveWarning < 60_000) return
  lastSaveWarning = now
  toast('프로젝트 기록을 저장하지 못했습니다 (저장 한도) — 앱을 닫으면 최근 변경이 사라질 수 있으니 끝난 프로젝트를 정리해 주세요', true)
}

/** 브라우저가 아닌 곳(단위 테스트)에서는 메모리에 둔다 */
function storage(): StateStorage {
  if (typeof localStorage !== 'undefined') return guardedStorage(localStorage)
  const mem = new Map<string, string>()
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k)
  }
}

type Persisted = Pick<ProjectsState, 'projects' | 'activeId' | 'presets'>

/**
 * 이 실행(앱 프로세스)에서 조합에 넣은 그림 id — 디스크의 프로젝트 기록에 닿았는지 알 수 없다.
 * 빠진 그림 찾기의 시작점(project/queue.ts adoptCutoff)은 이것을 빼고 정한다: 앱을 연 뒤 늦게 도는 찾기가 이번 실행에
 * 들어온 새 그림을 기준으로 삼으면 그보다 먼저(지난 실행에) 빠진 그림을 영영 건너뛴다
 */
const addedThisRun = new Set<number>()
export function addedInThisRun(imageId: number): boolean {
  return addedThisRun.has(imageId)
}

export const useProjects = create<ProjectsState>()(
  persist(
    (set, get) => {
      /** 프로젝트 하나를 바꿔 끼운다 (바뀐 게 없으면 그대로) */
      const update = (id: string, fn: (p: Project) => Project): void => {
        set((s) => {
          const i = s.projects.findIndex((p) => p.id === id)
          if (i < 0) return s
          const next = fn(s.projects[i])
          if (next === s.projects[i]) return s
          const projects = [...s.projects]
          projects[i] = next.updatedAt === s.projects[i].updatedAt ? { ...next, updatedAt: Date.now() } : next
          return { projects }
        })
      }
      const item = (projectId: string, key: string, fn: (i: AssetItem) => AssetItem): void =>
        update(projectId, (p) => model.withItem(p, key, fn))

      return {
        projects: [],
        activeId: null,
        presets: [],

        create: (name, params) => {
          const p = model.createProject(name, params)
          set((s) => ({ projects: [...s.projects, p], activeId: p.id }))
          return p.id
        },
        patch: (id, patch) => update(id, (p) => ({ ...p, ...patch })),
        remove: (id) =>
          set((s) => ({
            projects: s.projects.filter((p) => p.id !== id),
            activeId: s.activeId === id ? null : s.activeId
          })),
        duplicate: (id) => {
          const src = get().projects.find((p) => p.id === id)
          if (!src) return null
          const copy = model.duplicateProject(src)
          set((s) => {
            const i = s.projects.findIndex((p) => p.id === id)
            return { projects: [...s.projects.slice(0, i + 1), copy, ...s.projects.slice(i + 1)] }
          })
          return copy.id
        },
        setActive: (id) => set({ activeId: id }),

        addCharacter: (projectId, c) => {
          let id: string | null = null
          update(projectId, (p) => {
            const r = model.addCharacter(p, c)
            id = r.id
            return r.project
          })
          return id
        },
        patchCharacter: (projectId, charId, patch) =>
          update(projectId, (p) => ({
            ...p,
            characters: p.characters.map((c) => (c.id === charId ? { ...c, ...patch } : c))
          })),
        removeCharacter: (projectId, charId) => update(projectId, (p) => model.removeCharacter(p, charId)),
        moveCharacter: (projectId, charId, dir) => update(projectId, (p) => model.moveCharacter(p, charId, dir)),

        addAxis: (projectId, kind, name) => {
          let id: string | null = null
          update(projectId, (p) => {
            const r = model.addAxis(p, kind, name)
            id = r.id
            return r.project
          })
          return id
        },
        patchAxis: (projectId, axisId, patch) =>
          update(projectId, (p) => ({ ...p, axes: p.axes.map((a) => (a.id === axisId ? { ...a, ...patch } : a)) })),
        removeAxis: (projectId, axisId) => update(projectId, (p) => model.removeAxis(p, axisId)),
        moveAxis: (projectId, axisId, dir) => update(projectId, (p) => model.moveAxis(p, axisId, dir)),
        addValue: (projectId, axisId, v) => {
          let id: string | null = null
          update(projectId, (p) => {
            const r = model.addValue(p, axisId, v)
            id = r.id
            return r.project
          })
          return id
        },
        patchValue: (projectId, axisId, valueId, patch) =>
          update(projectId, (p) => ({
            ...p,
            axes: p.axes.map((a) =>
              a.id === axisId ? { ...a, values: a.values.map((v) => (v.id === valueId ? { ...v, ...patch } : v)) } : a
            )
          })),
        removeValue: (projectId, axisId, valueId) => update(projectId, (p) => model.removeValue(p, axisId, valueId)),
        moveValue: (projectId, axisId, valueId, dir) => update(projectId, (p) => model.moveValue(p, axisId, valueId, dir)),
        applyAxisTemplate: (projectId, templateId, opts) => {
          const t = AXIS_TEMPLATES.find((x) => x.id === templateId)
          if (!t) return null
          let id: string | null = null
          update(projectId, (p) => {
            const r = applyAxisTemplate(p, t, opts)
            id = r.axisId
            return r.project
          })
          return id
        },

        markQueued: (projectId, jobs) =>
          update(projectId, (p) =>
            jobs.reduce((acc, j) => (j.count > 0 ? model.withItem(acc, j.key, (i) => cur.bumpRuntime(i, { queued: j.count })) : acc), p)
          ),
        releaseQueued: (projectId, key, count) => item(projectId, key, (i) => cur.bumpRuntime(i, { queued: -count })),
        releaseRuntime: (projectId, deltas) =>
          update(projectId, (p) =>
            deltas.reduce(
              (acc, d) => model.withItem(acc, d.key, (i) => cur.bumpRuntime(i, { queued: -d.queued, generating: -d.generating })),
              p
            )
          ),
        markStarted: (projectId, key) =>
          item(projectId, key, (i) => cur.bumpRuntime(i, { queued: i.queued > 0 ? -1 : 0, generating: 1 })),
        cancelStarted: (projectId, key) => item(projectId, key, (i) => cur.bumpRuntime(i, { generating: -1 })),
        addImage: (projectId, key, image, opts) => {
          addedThisRun.add(image.id)
          item(projectId, key, (i) => cur.addImage(i, image, opts))
        },
        markFailed: (projectId, key) =>
          item(projectId, key, (i) =>
            cur.bumpRuntime(i, i.generating > 0 ? { generating: -1, failed: 1 } : { queued: -1, failed: 1 })
          ),

        setMarks: (projectId, key, ids, mark) => item(projectId, key, (i) => cur.setMarks(i, ids, mark)),
        setRepresentative: (projectId, key, id) => item(projectId, key, (i) => cur.setRepresentative(i, id)),
        replaceAdopted: (projectId, key, oldId, newId) => item(projectId, key, (i) => cur.replaceAdopted(i, oldId, newId)),
        setRedo: (projectId, key, on) =>
          item(projectId, key, (i) => {
            if (!!i.redo === on) return i
            const next = { ...i }
            if (on) next.redo = true
            else delete next.redo
            return next
          }),
        setDescription: (projectId, key, imageId, text) =>
          item(projectId, key, (i) => ({
            ...i,
            images: i.images.map((img) => (img.id === imageId ? { ...img, description: text } : img))
          })),

        setCodes: (projectId, codes) =>
          update(projectId, (p) =>
            codes.reduce((acc, c) => model.withItem(acc, c.key, (i) => cur.setSlotCodes(i, { [c.slot]: c.code })), p)
          ),
        markExported: (projectId, done, counters, opts) =>
          update(projectId, (p) => {
            const at = Date.now()
            let next = done.reduce(
              (acc, d) => model.withItem(acc, d.key, (i) => cur.markExported(i, d.imageId, d.path, at, d.bytes)),
              p
            )
            if (opts?.onDevice) {
              for (const d of done) {
                for (const [k, it] of Object.entries(next.items)) {
                  if (k === d.key) continue
                  const fixed = cur.forgetExportedPath(it, d.path, d.imageId)
                  if (fixed !== it) next = { ...next, items: { ...next.items, [k]: fixed } }
                }
              }
            }
            return counters ? { ...next, exportCounters: { ...next.exportCounters, ...counters } } : next
          }),
        forgetImages: (historyIds) => {
          const ids = new Set(historyIds)
          set((s) => ({
            projects: s.projects.map((p) => {
              let changed = false
              const items = { ...p.items }
              for (const [k, it] of Object.entries(p.items)) {
                if (!it.images.some((img) => ids.has(img.id))) continue
                items[k] = cur.removeImages(it, historyIds)
                changed = true
              }
              return changed ? { ...p, items, updatedAt: Date.now() } : p
            })
          }))
        },

        savePreset: (preset) => {
          const id = preset.id ?? model.newId()
          set((s) => {
            const next: PlatformPreset = { ...preset, id, name: preset.name.trim() || '이름 없는 프리셋' }
            return {
              presets: s.presets.some((x) => x.id === id) ? s.presets.map((x) => (x.id === id ? next : x)) : [...s.presets, next]
            }
          })
          return id
        },
        removePreset: (id) =>
          set((s) => ({
            presets: s.presets.filter((p) => p.id !== id),
            projects: s.projects.map((p) => (p.convertPresetId === id ? { ...p, convertPresetId: null } : p))
          }))
      }
    },
    {
      name: 'naip-projects',
      version: 1,
      storage: createJSONStorage(storage),
      partialize: (s): Persisted => ({ projects: s.projects, activeId: s.activeId, presets: s.presets }),
      // 빠진 칸 채우기 + 대기·생성 중 장수 초기화 (저장된 대기열의 장은 loadResume이 다시 센다)
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>
        return {
          ...current,
          activeId: p.activeId ?? null,
          presets: p.presets ?? [],
          projects: (p.projects ?? []).map((x) => model.resetRuntime(model.normalizeProject(x)))
        }
      }
    }
  )
)

/** 지금 고른 프로젝트 */
export function activeProject(s: Pick<ProjectsState, 'projects' | 'activeId'> = useProjects.getState()): Project | null {
  return s.projects.find((p) => p.id === s.activeId) ?? null
}

/**
 * 히스토리 보관 한도 정리(자동 삭제)에서 지우지 않을 그림 — 프로젝트에 든 그림 중 탈락이 아닌 것(미선별·채택·보류),
 * 내보낸 것, 대표 그림. 이것들은 사용자가 직접 지울 때만 지운다 (모르는 사이에 지우면 조합이 비어 다시 생성·과금하게 된다)
 */
export function projectKeptImageIds(s: Pick<ProjectsState, 'projects'> = useProjects.getState()): Set<number> {
  const ids = new Set<number>()
  for (const p of s.projects) {
    for (const it of Object.values(p.items)) {
      if (it.representative !== undefined) ids.add(it.representative)
      for (const img of it.images) if (img.mark !== 'rejected' || img.exported) ids.add(img.id)
    }
  }
  return ids
}

/** 히스토리를 모두 지웠을 때 — 모든 프로젝트에서 그림을 뺀다 (선별·코드 기록은 칸에 남는다) */
export function forgetAllProjectImages(): void {
  const s = useProjects.getState()
  const ids = s.projects.flatMap((p) => Object.values(p.items).flatMap((i) => i.images.map((img) => img.id)))
  if (ids.length) s.forgetImages(ids)
}
