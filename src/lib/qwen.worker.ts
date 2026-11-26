/// <reference lib="webworker" />
/**
 * V5(Qwen) 프롬프트 토큰 카운터 워커 — NAIS3의 qwen-tokenizer 를 웹뷰용으로 옮긴 것.
 * 토크나이저 사전(public/qwen35, Apache-2.0)은 기기 안에서만 읽고 프롬프트를 밖으로 보내지 않는다.
 * 사전이 커서(압축 3.5MB) 처음 한 번 읽는 데 시간이 걸리므로 화면과 다른 스레드에서 돈다.
 */
import { Tokenizer } from '@huggingface/tokenizers'

let tokenizer: Promise<Tokenizer> | null = null

async function readJson(url: string): Promise<object> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`tokenizer ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  // 서버가 미리 풀어서 주는 경우도 있어 gzip 매직 넘버를 보고 판단한다
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return JSON.parse(await new Response(stream).text()) as object
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as object
}

function load(base: string): Promise<Tokenizer> {
  tokenizer ??= Promise.all([
    readJson(`${base}tokenizer.json.gz`),
    readJson(`${base}tokenizer_config.json.gz`)
  ])
    .then(([json, config]) => new Tokenizer(json, config))
    .catch((e) => {
      tokenizer = null
      throw e
    })
  return tokenizer
}

onmessage = async (e: MessageEvent<{ id: number; base: string; texts: string[] }>) => {
  const { id, base, texts } = e.data
  try {
    const tok = await load(base)
    const counts = texts.map((text) => tok.encode(text, { add_special_tokens: false }).ids.length)
    postMessage({ id, counts })
  } catch (err) {
    postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
