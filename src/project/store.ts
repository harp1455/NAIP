/**
 * 에셋 프로젝트 저장소 (zustand persist, localStorage 'naip-projects').
 * 계산은 모두 순수 함수(model·curation)에 맡기고, 여기서는 프로젝트를 찾아 바꿔 끼우기만 한다.
 *
 * 생성 대기열과 연결 (리드):
 *   planJobs → 배치에 넣을 때 markQueued, 한 장 요청을 시작할 때 markStarted,
 *   히스토리에 저장되면 addImage(분류 표시 tag의 key로), 실패하면 markFailed,
 *   멈춤·대기열에서 뺄 때 못 뽑은 장수만큼 releaseQueued.
 *   앱을 다시 열면 대기·생성 중 장수는 0으로 돌아간다 (대기열은 저장되지 않으므로).
 */
import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
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

  // ── 생성 진행 (대기열 연결)
  markQueued: (projectId: string, jobs: readonly { key: string; count: number }[]) => void
  releaseQueued: (projectId: string, key: string, count: number) => void
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
  markExported: (
    projectId: string,
    done: readonly { key: string; imageId: number; path: string; bytes?: number }[],
    counters?: Record<string, number>
  ) => void
  /** 히스토리에서 지운 그림을 모든 프로젝트에서 뺀다 */
  forgetImages: (historyIds: number[]) => void

  // ── 변환 프리셋 (사용자 정의만)
  savePreset: (p: Omit<PlatformPreset, 'id'> & { id?: string }) => string
  removePreset: (id: string) => void
}

/** 브라우저가 아닌 곳(단위 테스트)에서는 메모리에 둔다 */
function storage(): StateStorage {
  if (typeof localStorage !== 'undefined') return localStorage
  const mem = new Map<string, string>()
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k)
  }
}

type Persisted = Pick<ProjectsState, 'projects' | 'activeId' | 'presets'>

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

        markQueued: (projectId, jobs) =>
          update(projectId, (p) =>
            jobs.reduce((acc, j) => (j.count > 0 ? model.withItem(acc, j.key, (i) => cur.bumpRuntime(i, { queued: j.count })) : acc), p)
          ),
        releaseQueued: (projectId, key, count) => item(projectId, key, (i) => cur.bumpRuntime(i, { queued: -count })),
        markStarted: (projectId, key) =>
          item(projectId, key, (i) => cur.bumpRuntime(i, { queued: i.queued > 0 ? -1 : 0, generating: 1 })),
        cancelStarted: (projectId, key) => item(projectId, key, (i) => cur.bumpRuntime(i, { generating: -1 })),
        addImage: (projectId, key, image, opts) => item(projectId, key, (i) => cur.addImage(i, image, opts)),
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
        markExported: (projectId, done, counters) =>
          update(projectId, (p) => {
            const at = Date.now()
            const next = done.reduce(
              (acc, d) => model.withItem(acc, d.key, (i) => cur.markExported(i, d.imageId, d.path, at, d.bytes)),
              p
            )
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
      // 빠진 칸 채우기 + 대기·생성 중 장수 초기화 (대기열은 저장되지 않는다)
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

/** 히스토리를 모두 지웠을 때 — 모든 프로젝트에서 그림을 뺀다 (선별·코드 기록은 칸에 남는다) */
export function forgetAllProjectImages(): void {
  const s = useProjects.getState()
  const ids = s.projects.flatMap((p) => Object.values(p.items).flatMap((i) => i.images.map((img) => img.id)))
  if (ids.length) s.forgetImages(ids)
}
