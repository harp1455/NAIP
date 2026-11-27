/**
 * NAIS3 `.nais` 테스트 픽스처 생성기 — NAIS3 자신의 코드로 진짜 아카이브를 만든다.
 *
 * NAIS3 (© sunanakgo, GPL-3.0) 의 src/main/db/migrations.ts 로 빈 작업 공간 DB를 만들고
 * (v18의 기본 Danbooru 조각까지 그대로 들어간다), NAIS3 repo 들이 쓰는 것과 같은 열로 행을 넣은 뒤,
 * src/main/backup/repo.ts 의 captureBackupSource() 를 옮긴 함수로 스냅샷을 떠서
 * src/main/backup/archive.ts 의 writeNaisArchive() (yazl 스트리밍 writer) 로 쓴다.
 * 바이브 인코딩 캐시는 src/main/refs/vibe-encoding-cache.ts 의 putVibeEncoding() 으로 만든다.
 *
 * 앱 빌드에는 쓰이지 않는다. 다시 만들 때만:
 *   git clone https://github.com/sunanakgo/NAIS3 <NAIS3>
 *   (빈 폴더에서) npm i better-sqlite3 yazl@3 jszip@3 esbuild
 *   NODE_PATH=<그 폴더>/node_modules node tests/fixtures/nais3/build-fixtures.mjs <NAIS3> tests/fixtures/nais3
 *
 * NAIP 가 내보낸 .nais 를 NAIS3 의 실제 복원 코드(repo.ts importNais → restoreBackupDatabase)로
 * 새 작업 공간 DB 에 넣어 보기:
 *   NAIP_EXPORT_NAIS=/tmp/x.nais npx vitest run tests/nais3.test.ts
 *   NODE_PATH=... node tests/fixtures/nais3/build-fixtures.mjs <NAIS3> --verify /tmp/x.nais
 */
import { createRequire } from 'module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const args = process.argv.slice(2)
const verifyAt = args.indexOf('--verify')
const verifyFile = verifyAt >= 0 ? resolve(args.splice(verifyAt, 2)[1]) : null
const [nais3Dir, outDir] = args.map((p) => resolve(p))
if (!nais3Dir || (!outDir && !verifyFile)) {
  console.error('usage: node build-fixtures.mjs <NAIS3 checkout> <output dir> | --verify <file.nais>')
  process.exit(1)
}
const nodePath = (process.env.NODE_PATH ?? '').split(':').filter(Boolean)
const require = createRequire(join(nodePath[0] ?? process.cwd(), 'noop.js'))
const esbuild = require('esbuild')

if (verifyFile) {
  await verify(verifyFile)
  process.exit(0)
}

/** NAIS3 repo.ts 를 그대로 묶되, electron 에 기대는 모듈(getDb·설정·라이브러리 폴더·씬 이벤트)만 바꿔 끼운다 */
async function verify(file) {
  const stubs = {
    '../db': 'export function getDb() { return globalThis.__naisDb }',
    '../db/settings':
      'export function getSetting(k) { return globalThis.__naisSettings.get(k) ?? null }\nexport function setSetting(k, v) { globalThis.__naisSettings.set(k, v) }',
    '../images/storage': 'export function libraryRoot() { return globalThis.__naisLibraryRoot }',
    '../scenes/events': "import { EventEmitter } from 'events'\nexport const sceneEvents = new EventEmitter()"
  }
  const bundle = await esbuild.build({
    stdin: {
      contents: `export { importNais } from ${JSON.stringify(join(nais3Dir, 'src/main/backup/repo.ts'))}
export { migrations } from ${JSON.stringify(join(nais3Dir, 'src/main/db/migrations.ts'))}`,
      resolveDir: nais3Dir,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    nodePaths: nodePath,
    external: ['better-sqlite3', 'yazl', 'jszip'],
    plugins: [
      {
        name: 'nais3-stubs',
        setup(b) {
          b.onResolve({ filter: /^\.\.\/(db|db\/settings|images\/storage|scenes\/events)$/ }, (a) =>
            a.importer.includes('/backup/') ? { path: a.path, namespace: 'stub' } : undefined
          )
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js', resolveDir: nais3Dir }))
        }
      }
    ]
  })
  const m = { exports: {} }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(m, m.exports, require)
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migrate of m.exports.migrations) db.transaction(() => migrate(db))()
  const root = mkdtempSync(join(tmpdir(), 'nais3-verify-'))
  globalThis.__naisDb = db
  globalThis.__naisSettings = new Map()
  globalThis.__naisLibraryRoot = root
  const { imported } = await m.exports.importNais(readFileSync(file))
  const counts = {}
  for (const t of ['character_folders', 'character_prompts', 'fragment_folders', 'fragments', 'prompt_presets', 'scene_presets', 'gen_scenes', 'vibe_images', 'charref_images']) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  }
  const files = db.prepare('SELECT file_path FROM vibe_images UNION ALL SELECT file_path FROM charref_images').all()
  const missing = files.filter((f) => !existsSync(f.file_path)).length
  console.log(`NAIS3 restored ${imported} rows`, counts, `main_params=${globalThis.__naisSettings.has('main_params')}`, `missing files=${missing}`)
  rmSync(root, { recursive: true, force: true })
}

// NAIS3 원본 모듈을 그대로 묶는다 (better-sqlite3·yazl·jszip 은 바깥 node_modules 에서)
const entry = `
export { migrations } from ${JSON.stringify(join(nais3Dir, 'src/main/db/migrations.ts'))}
export { writeNaisArchive, readNaisArchive } from ${JSON.stringify(join(nais3Dir, 'src/main/backup/archive.ts'))}
export { BACKUP_TABLES, BACKUP_FORMAT_VERSION } from ${JSON.stringify(join(nais3Dir, 'src/main/backup/types.ts'))}
export { putVibeEncoding } from ${JSON.stringify(join(nais3Dir, 'src/main/refs/vibe-encoding-cache.ts'))}
`
const built = await esbuild.build({
  stdin: { contents: entry, resolveDir: nais3Dir, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  nodePaths: nodePath,
  external: ['better-sqlite3', 'yazl', 'jszip']
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
const { migrations, writeNaisArchive, readNaisArchive, BACKUP_TABLES, BACKUP_FORMAT_VERSION, putVibeEncoding } =
  mod.exports
const Database = require('better-sqlite3')

// 8×8 PNG 몇 장 (픽셀 값만 다르게) — 레퍼런스·바이브·라이브러리 원본
function png(seed) {
  const zlib = require('zlib')
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(8 * (1 + 8 * 3))
  for (let y = 0; y < 8; y++) for (let x = 0; x < 24; x++) raw[y * 25 + 1 + x] = (seed * 37 + x * 11 + y * 5) & 0xff
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const work = mkdtempSync(join(tmpdir(), 'nais3-fixture-'))
const refsDir = join(work, 'refs')
mkdirSync(refsDir)
const file = (name, data) => {
  const p = join(refsDir, name)
  writeFileSync(p, data)
  return p
}
// NAIS3 썸네일은 192×192 webp BLOB — 여기서는 작은 PNG 바이트로 대신한다 (확장자 판별에 쓰이지 않음)
const thumb = (seed) => png(100 + seed)

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
for (const migrate of migrations) db.transaction(() => migrate(db))()
const settings = new Map()

// ── 캐릭터 ──
db.prepare('INSERT INTO character_folders (id, name, sort_order, collapsed, color) VALUES (?, ?, ?, ?, ?)').run(1, '주인공들', 0, 1, '#e11d48')
const insChar = db.prepare(
  `INSERT INTO character_prompts (id, name, prompt, negative_prompt, thumbnail, settings_json, enabled, center_x, center_y, folder_id, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
insChar.run(1, 'Alice', '1girl, blonde hair, blue eyes', 'bad hands', thumb(1), '{}', 1, 0.3, 0.5, 1, 2)
insChar.run(2, 'Bob', '1boy, black hair', '', null, '{}', 1, 0.7, 0.5, null, 1)
insChar.run(3, 'Alice', '1girl, school uniform', 'extra arms', null, '{"note":"x"}', 0, 0.5, 0.5, null, 3)

// ── 조각 (기본 Danbooru 조각은 v18 마이그레이션이 이미 넣었다) ──
db.prepare('INSERT INTO fragment_folders (id, name, sort_order, collapsed, color) VALUES (?, ?, ?, ?, ?)').run(50, '포즈', 9, 0, null)
db.prepare('INSERT INTO fragments (name, content, folder_id, sort_order) VALUES (?, ?, ?, ?)').run('pose', 'standing\nsitting\n# 주석 줄\nlying', 50, 100)
db.prepare('INSERT INTO fragments (name, content, folder_id, sort_order) VALUES (?, ?, ?, ?)').run('time', 'day\nnight', null, 101)

// ── 바이브 ──
db.prepare('INSERT INTO vibe_folders (id, name, sort_order, collapsed, color) VALUES (?, ?, ?, ?, ?)').run(1, '스타일', 0, 0, null)
const insVibe = db.prepare(
  `INSERT INTO vibe_images (id, name, file_path, thumbnail, enabled, strength, info_extracted, encoded, encoded_ie, folder_id, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
let cache = putVibeEncoding(null, null, 'nai-diffusion-4-5-full', 0.7, 'ENC45FULL07')
cache = putVibeEncoding(cache, null, 'nai-diffusion-4-5-curated', 1, 'ENC45CUR10')
insVibe.run(1, 'watercolor', file('v1.png', png(1)), thumb(2), 1, 0.55, 0.7, cache, 0.7, 1, 1)
// 예전 형식: encoded 에 맨 인코딩 + encoded_ie (4.5 Full 로 취급)
insVibe.run(2, 'legacy', file('v2.jpg', png(2)), null, 0, 0.6, 1, 'LEGACYENC', 1, null, 2)
// 메타데이터에서 되살린 인코딩 전용 바이브 — 파일 내용이 곧 캐시
const onlyCache = putVibeEncoding(null, null, 'nai-diffusion-4-5-full', 1, 'METAENC')
insVibe.run(3, '메타데이터 바이브 1', file('v3.nais3vibe', onlyCache), thumb(3), 1, 0.4, 1, onlyCache, 1, null, 3)
// 인코딩이 아직 없는 바이브
insVibe.run(4, 'raw', file('v4.webp', png(4)), null, 0, 0.6, 0.7, null, null, null, 4)

// ── 정밀 레퍼런스 (V5 종류 포함) ──
db.prepare('INSERT INTO charref_folders (id, name, sort_order, collapsed, color) VALUES (?, ?, ?, ?, ?)').run(1, '의상', 0, 0, null)
const insRef = db.prepare(
  `INSERT INTO charref_images (id, name, file_path, thumbnail, enabled, ref_type, strength, fidelity, folder_id, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
const refTypes = ['character', 'character_mainoutfit', 'style', 'character&style', 'character&style_anyoutfit', 'costume', 'delta']
refTypes.forEach((type, i) => {
  insRef.run(i + 1, `ref-${type}`, file(`r${i + 1}.png`, png(10 + i)), thumb(10 + i), i % 2, type, 0.5 + i * 0.5, 0.8, i === 5 ? 1 : null, i)
})

// ── 씬 ── (v8 이 프리셋 1 "기본"을 이미 만들었다)
db.prepare('INSERT INTO scene_presets (id, name, sort_order, default_width, default_height, character_ids) VALUES (?, ?, ?, ?, ?, ?)').run(2, '야외', 1, 1024, 1024, '[1,2]')
const insScene = db.prepare(
  `INSERT INTO gen_scenes (id, preset_id, name, prompt, negative_prompt, width, height, sort_order, reserve_count, reserve_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
insScene.run(1, 1, '교실', 'classroom, desk', 'lowres', 832, 1216, 0, 3, '{"":3}', '2026-11-01 10:00:00')
insScene.run(2, 2, '해변', 'beach, ocean', '', 1216, 832, 0, 2, '{"":1,"cast-abc":1}', '2026-11-02 10:00:00')
insScene.run(3, 2, '숲', 'forest', '', 1024, 1024, 1, 0, null, '2026-11-03 10:00:00')

// ── 프롬프트 프리셋 ──
const insPreset = db.prepare(
  'INSERT INTO prompt_presets (id, name, prompt, negative_prompt, sort_order, params_json, prompt_parts_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
)
const fullParams = {
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
insPreset.run(1, '기본 프리셋', 'masterpiece, 1girl, smile', 'lowres', 0, JSON.stringify(fullParams), JSON.stringify({ base: 'masterpiece', additional: '1girl', detail: 'smile' }))
insPreset.run(2, '예전 프리셋', 'old prompt', '', 1, null, null)
insPreset.run(3, 'V5 일부', 'v5 test', 'bad', 2, JSON.stringify({ model: 'nai-diffusion-5-full', steps: 23 }), null)
insPreset.run(4, '깨진 파라미터', 'broken', '', 3, '{not json', null)

// ── 라이브러리 (NAIP에 대응 없음) ──
db.prepare('INSERT INTO library_stacks (id, name) VALUES (?, ?)').run(1, '모음')
db.prepare('INSERT INTO library_images (id, name, file_path, thumbnail, width, height, stack_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 'lib-1', file('l1.png', png(30)), thumb(30), 8, 8, 1, 1)
db.prepare('INSERT INTO library_images (id, name, file_path, thumbnail, width, height, stack_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(2, 'lib-2', file('l2.png', png(31)), null, 8, 8, null, 2)

settings.set(
  'main_params',
  JSON.stringify({
    prompt: 'masterpiece, 1girl, smile, outdoors',
    promptParts: { base: 'masterpiece', additional: '1girl, smile', detail: 'outdoors' },
    negativePrompt: 'lowres, bad anatomy',
    model: 'nai-diffusion-5-full',
    width: 1024,
    height: 1024,
    steps: 23,
    cfgScale: 4.5,
    cfgRescale: 0.1,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    seed: 12345,
    variety: true,
    qualityToggle: true,
    ucPreset: 1,
    transparentBackground: true,
    characterPrompts: []
  })
)

// NAIS3 src/main/backup/repo.ts captureBackupSource() 와 같은 방식 (getDb/getSetting 만 이 DB로)
const FILE_BACKED_TABLES = new Set(['vibe_images', 'charref_images', 'library_images'])
function captureBackupSource() {
  const tables = {}
  const files = []
  for (const table of BACKUP_TABLES) {
    const rows = []
    for (const sourceRow of db.prepare(`SELECT * FROM ${table}`).all()) {
      const row = { ...sourceRow }
      if (FILE_BACKED_TABLES.has(table)) {
        const ext = (row.file_path.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? '.bin').toLowerCase()
        files.push({ table, rowId: row.id, column: 'file_path', extension: ext, sourcePath: row.file_path })
        row.file_path = ''
      }
      rows.push(row)
    }
    tables[table] = rows
  }
  return {
    version: BACKUP_FORMAT_VERSION,
    includedTables: [...BACKUP_TABLES],
    tables,
    mainParams: settings.get('main_params') || null,
    files
  }
}

mkdirSync(outDir, { recursive: true })
const dest = join(outDir, 'workspace.nais')
rmSync(dest, { force: true })
const { skippedFiles } = await writeNaisArchive(dest, captureBackupSource(), '1.0.33', '2026-11-27T00:00:00.000Z')
// NAIS3 자신의 reader 로 다시 읽어 본다
const back = await readNaisArchive(require('fs').readFileSync(dest))
console.log(
  `wrote ${dest} (skipped ${skippedFiles}):`,
  Object.fromEntries(Object.entries(back.tables).map(([t, rows]) => [t, rows.length])),
  `${back.files.length} files`
)

// 일부 테이블만 든 아카이브 (NAIS3 가 읽을 수 있는 최소 형태) — 바이브 파일 하나를 지운 채 써서 skippedFiles 경로도 남긴다
rmSync(join(refsDir, 'v4.webp'))
const partial = captureBackupSource()
partial.includedTables = ['character_folders', 'character_prompts', 'vibe_folders', 'vibe_images']
partial.mainParams = null
const dest2 = join(outDir, 'partial.nais')
rmSync(dest2, { force: true })
const r2 = await writeNaisArchive(dest2, partial, '1.0.33', '2026-11-27T00:00:00.000Z')
console.log(`wrote ${dest2} (skipped ${r2.skippedFiles})`)
rmSync(work, { recursive: true, force: true })
