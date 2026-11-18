// A chamada ao especialista, do jeito do mod: o prompt do modo lido da pasta do mod, a entrada e as travas do core.ts
// (as mesmas do ALRIX Code), o `$.model.complete` com tempo-limite e com o cancelamento ligado ao Esc e à faixa.
import type { EngineInterface, ModelCompleteResult } from 'claude-code'

import type { Expert, ExpertInput, Turn } from './core'
import { EXPERT_MODEL, inputFor, judge, maxTokensFor, PLAN } from './core'

export type Rewrite = { ms: number; tokensIn: number; tokensOut: number } & (
  | { isOk: true; text: string; gaps: string[] }
  | { isOk: false; isCancelled: boolean; note: string }
)

/** ALRIX_PROMPT_LACUNAS=0 esconde as lacunas: o Engenharia segue igual, só não mostra o que falta no pedido. */
async function showsGaps($: EngineInterface): Promise<boolean> {
  return (await $.env.get('ALRIX_PROMPT_LACUNAS').catch(() => undefined)) !== '0'
}

async function recentTurns($: EngineInterface): Promise<Turn[]> {
  const rows = await $.session.messages()
  return rows.map(row => ({ role: row.role === 'user' ? 'user' : 'assistant', text: row.text }))
}

/** O que o especialista lê além da mensagem: quem vai ler (o modelo desta sessão), a pasta e, no Engenharia, a conversa. */
async function inputOf($: EngineInterface, expert: Expert, text: string): Promise<ExpertInput> {
  const model = await $.session.model().catch(() => '')
  return {
    text,
    harness: 'claude',
    ...(model === '' ? {} : { model }),
    cwd: await $.session.cwd(),
    recent: expert === 'engenharia' ? await recentTurns($) : [],
  }
}

const failureNote = (result: Extract<ModelCompleteResult, { isAnswered: false }>): string =>
  result.reason === 'api-error' ? `erro da API ${result.status ?? ''} ${result.error}`.replace(/\s+/g, ' ').trim() : result.reason

/** Chama o especialista do modo e devolve a reescrita aprovada pelas travas, ou o motivo de não usá-la. */
export async function rewrite($: EngineInterface, expert: Expert, text: string, signal: AbortSignal): Promise<Rewrite> {
  const plan = PLAN[expert]
  const system = await $.fs.read(`${$.plugin.root}/prompts/${plan.file}`)
  const input = await inputOf($, expert, text)
  const started = await $.clock.now()
  const result = await $.model.complete(
    {
      model: EXPERT_MODEL,
      system: [{ text: system, cache: true }],
      prompt: inputFor(expert, input),
      effort: plan.effort,
      maxTokens: maxTokensFor(expert, text),
      timeoutMs: plan.timeoutMs,
    },
    { signal },
  )
  const { usage } = result
  const cost = {
    ms: (await $.clock.now()) - started,
    tokensIn: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    tokensOut: usage.output_tokens,
  }
  if (!result.isAnswered) {
    const isCancelled = result.reason === 'aborted' && signal.aborted
    return { ...cost, isOk: false, isCancelled, note: isCancelled ? 'cancelada' : result.reason === 'aborted' ? 'passou do tempo' : failureNote(result) }
  }
  const verdict = judge(expert, input, result.text)
  if ('reason' in verdict) return { ...cost, isOk: false, isCancelled: false, note: verdict.reason }
  return { ...cost, isOk: true, text: verdict.text, gaps: verdict.gaps.length > 0 && (await showsGaps($)) ? verdict.gaps : [] }
}
