/**
 * 假 Provider：把「模型返回某个 tool_call」写成固定脚本。
 * 以后改 Tool 不用真发请求、不用花 token，也不会因为模型抽风导致测试随机失败。
 */

export interface ScriptedDelta {
  choices: {
    delta: {
      content?: string
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
}

export function contentChunk(text: string): ScriptedDelta {
  return { choices: [{ delta: { content: text } }] }
}

export function toolCallChunk(id: string, name: string, args: unknown, index = 0): ScriptedDelta {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id, function: { name, arguments: JSON.stringify(args) } }
          ]
        }
      }
    ]
  }
}

/** rounds：每一轮（一次请求）依次吐出的 chunk */
export function scriptedProvider(rounds: ScriptedDelta[][], delay = 1) {
  let round = 0
  return async function* () {
    const chunks = rounds[Math.min(round, rounds.length - 1)] ?? []
    round++
    for (const chunk of chunks) {
      yield chunk as unknown as Record<string, unknown>
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}
