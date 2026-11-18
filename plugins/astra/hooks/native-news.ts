import type { EngineInterface, SessionAppendInput, SessionAppendResult, SessionMessage } from 'claude-code'
import { wasSteered } from './native-steer'

/**
 * O que chega a um loop do Codex fora das linhas de `$.session.messages()`: o recado que o Claude Code entrega na
 * fronteira de uma ferramenta (o texto digitado no meio do turno, o SendMessage do coordenador, o aviso de um agente
 * que terminou), e o resultado de uma ferramenta que a ponte já tinha passado adiante. Medido em 25/10: a entrega só
 * aparece no `session.append`, pela porta `delivery`, como anexo `queued_command`.
 */
const MAX_NEWS = 20
const MAX_RESULT_CHARS = 100_000
const REMINDER_TAG = /<\/?system-reminder\b[^>]*>/g

/** Os loops que já tiveram um passo GPT nesta carga: só a caixa deles recebe entrega. */
const gptLoops = new Set<string>()
const boxes = new Map<string, readonly string[]>()

export const markGptLoop = (key: string): void => {
  gptLoops.add(key)
}
export const isGptLoop = (key: string): boolean => gptLoops.has(key)

/** As entregas de `key` desde o último passo; a caixa fica vazia. */
export function takeNews(key: string): readonly string[] {
  const news = boxes.get(key) ?? []
  boxes.delete(key)
  return news
}

/** O que não chegou ao Codex volta à caixa, na frente do que entrou depois. */
export function putBack(key: string, news: readonly string[]): void {
  if (news.length > 0) boxes.set(key, [...news, ...(boxes.get(key) ?? [])].slice(-MAX_NEWS))
}

/** O `/clear`: o loop principal da sessão que acabou não recebe mais nada. */
export function forgetLoop(key: string): void {
  gptLoops.delete(key)
  boxes.delete(key)
}

const textOf = (e: SessionAppendInput): string =>
  e.message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n').replace(REMINDER_TAG, '').trim()

/**
 * O hook do `session.append` na porta `delivery`: guarda a entrega de um loop GPT e deixa a linha seguir como veio. A
 * entrega de um recado que o turno do Codex já recebeu por steer (`native-steer.ts`) não entra na caixa.
 */
export async function onDelivery($: EngineInterface, e: SessionAppendInput, next: (e: SessionAppendInput) => Promise<SessionAppendResult>): Promise<SessionAppendResult> {
  const key = e.agentId ?? `main:${await $.session.id()}`
  const text = textOf(e)
  if (isGptLoop(key) && text !== '' && !(await wasSteered(key, text))) boxes.set(key, [...(boxes.get(key) ?? []), text].slice(-MAX_NEWS))
  return next(e)
}

/** Um resultado de ferramenta do Claude Code que o turno do Codex não recebeu. */
export type Late = { tool: string; text: string; isError: boolean }

const clipped = (text: string): string =>
  text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n[astra] (cortado: mais ${text.length - MAX_RESULT_CHARS} caracteres)`

/** O texto que leva ao Codex os resultados tardios, por `turn/steer` ou como pedido de um turno novo. */
export function lateText(late: readonly Late[]): string {
  if (late.length === 0) return ''
  const parts = late.map(item => `### ${item.tool}${item.isError ? ' (erro)' : ''}\n${clipped(item.text)}`)
  return ['[astra] Resultados das ferramentas do Claude Code que chegaram depois que o turno anterior foi encerrado:', ...parts].join('\n\n')
}

/**
 * Os resultados da última rodada de ferramentas, lidos do transcript: o caminho quando a ponte não tem mais a chamada
 * pendente (ela reiniciou, ou o mod recarregou) e o turno do Codex não vai recebê-los.
 */
export function resultsOfLastRound(rows: readonly SessionMessage[]): readonly Late[] {
  const at = rows.findLastIndex(row => row.role === 'assistant')
  const uses = rows[at]?.toolUses ?? []
  const results = rows.slice(at + 1).flatMap(row => row.toolResults ?? [])
  return uses.flatMap(use => {
    const result = results.find(candidate => candidate.tool_use_id === use.tool_use_id)
    return result === undefined ? [] : [{ tool: use.tool, text: result.text, isError: result.isError }]
  })
}
