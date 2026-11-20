/**
 * T5 unigram 토크나이저 — V4/4.5 프롬프트 토큰 카운트용 (한도 512).
 * NAIS3 src/main/nai/tokenizer.ts 이식. vocab은 public/t5_vocab.json 을 지연 로드한다.
 */
interface Vocab {
  pieces: Map<string, number>
  maxPieceLength: number
  unkScore: number
}

let vocab: Vocab | null = null
let loading: Promise<Vocab> | null = null

export function loadTokenizer(): Promise<Vocab> {
  if (vocab) return Promise.resolve(vocab)
  loading ??= fetch('./t5_vocab.json')
    .then((r) => r.json() as Promise<{ vocab: [string, number][] }>)
    .then((def) => {
      const pieces = new Map<string, number>()
      let maxPieceLength = 0
      let minScore = Infinity
      for (const [piece, score] of def.vocab) {
        pieces.set(piece, score)
        maxPieceLength = Math.max(maxPieceLength, piece.length)
        if (score < minScore) minScore = score
      }
      vocab = { pieces, maxPieceLength, unkScore: minScore - 10 }
      return vocab
    })
  return loading
}

function viterbiCount(piece: string, v: Vocab): number {
  const n = piece.length
  const bestScore = new Float64Array(n + 1).fill(-Infinity)
  const bestCount = new Int32Array(n + 1)
  bestScore[0] = 0
  for (let i = 0; i < n; i++) {
    if (bestScore[i] === -Infinity) continue
    const maxLen = Math.min(v.maxPieceLength, n - i)
    let matched = false
    for (let len = 1; len <= maxLen; len++) {
      const s = v.pieces.get(piece.slice(i, i + len))
      if (s === undefined) continue
      matched = true
      const score = bestScore[i] + s
      if (score > bestScore[i + len]) {
        bestScore[i + len] = score
        bestCount[i + len] = bestCount[i] + 1
      }
    }
    if (!matched) {
      const score = bestScore[i] + v.unkScore
      if (score > bestScore[i + 1]) {
        bestScore[i + 1] = score
        bestCount[i + 1] = bestCount[i] + 1
      }
    }
  }
  return bestCount[n]
}

/** 웹과 동일한 카운트: []{} 및 수치 가중치(N:: / ::) 제거 → 공백 분할 → unigram → +EOS(1) */
export function countTokens(text: string, v: Vocab): number {
  const cleaned = text.replace(/[[\]{}]/g, '').replace(/-?\d*\.?\d*::/g, '')
  const parts = cleaned.split(/\s+/).filter((p) => p.length > 0)
  let total = 1
  for (const part of parts) total += viterbiCount('▁' + part, v)
  return total
}
