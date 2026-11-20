import { useEffect, useState } from 'react'
import { countTokens, loadTokenizer } from '../nai/tokenizer'
import { isV5Model } from '../nai/models'

/**
 * 기본 프롬프트 + 캐릭터 프롬프트들의 합산 토큰 수 (T5, V4/V4.5).
 * V5(Qwen)는 토크나이저를 싣지 않아 null — 호출 측이 글자수로 대체 표시한다.
 */
export function useTokenCount(model: string, texts: string[]): number | null {
  const [count, setCount] = useState<number | null>(null)
  const key = texts.join('\u0000')
  useEffect(() => {
    if (isV5Model(model)) {
      setCount(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      void loadTokenizer()
        .then((v) => {
          if (!live) return
          const parts = key.split('\u0000').filter((s) => s.trim())
          // 각 카운트의 EOS(1)는 전체에서 한 번만 센다
          setCount(parts.reduce((n, s) => n + countTokens(s, v) - 1, 1))
        })
        .catch(() => live && setCount(null))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [model, key])
  return count
}
