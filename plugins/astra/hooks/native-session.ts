import type { EngineInterface, On, SessionCompactInput, SessionCompactResult, SessionEndInput, SessionEndResult, SessionMessage, TurnCompleteInput, TurnCompleteResult } from 'claude-code'
import { bridgeCall, liveBridge } from './bridge-client'
import { forgetNativeLoop, isGptModel } from './native'
import { forgetLoopCwd } from './native-agent'
import { forgetContext, onContext } from './native-context'
import { forgetLoop, isGptLoop, onDelivery } from './native-news'
import { forgetLive, onSubmit } from './native-steer'
import { COMPACT_MARK } from './request'

/**
 * A compactação e o `/clear` de um loop do Codex. O motor não compacta uma conversa GPT: ele chama o resumo com o id
 * do modelo e falha, e o pedido seguinte para em "Prompt is too long" (medido em 25/10). A conversa de verdade está na
 * thread do Codex, que se compacta sozinha aos 400 mil tokens: o mod só tira do transcript o que já ficou para trás.
 */
const MAX_TAIL_CHARS = 200_000
const LIMIT_NOTE = 'a thread se compacta sozinha perto de 400 mil tokens'

const sizeOf = (row: SessionMessage): number =>
  row.text.length + row.toolUses.reduce((sum, use) => sum + JSON.stringify(use.input).length, 0) + (row.toolResults ?? []).reduce((sum, result) => sum + result.text.length, 0)

/**
 * O que fica: do último pedido em texto em diante, com o handle do motor; grande demais, da última resposta em diante
 * (o turno em curso precisa dos resultados da última rodada de ferramentas).
 */
export function tailOf(messages: readonly SessionMessage[]): readonly SessionMessage[] {
  const lastAsk = messages.findLastIndex(row => row.role === 'user' && row.text.trim() !== '' && (row.toolResults ?? []).length === 0)
  const tail = messages.slice(Math.max(lastAsk, 0))
  if (tail.reduce((sum, row) => sum + sizeOf(row), 0) <= MAX_TAIL_CHARS) return tail
  const lastAnswer = messages.findLastIndex(row => row.role === 'assistant')
  return lastAnswer > lastAsk ? messages.slice(lastAnswer) : tail
}

async function isGptCompaction($: EngineInterface, e: SessionCompactInput): Promise<boolean> {
  return e.agentId === undefined ? isGptModel(await $.session.model()) : isGptLoop(e.agentId)
}

/** O `/compact` também compacta a thread do Codex, se a ponte está de pé; a que roda um turno não compacta agora. */
async function compactCodex($: EngineInterface, key: string): Promise<string> {
  const bridge = liveBridge()
  if (bridge === undefined) return `a ponte do Codex não está aberta, e ${LIMIT_NOTE}`
  const answer = await bridgeCall($, bridge, '/compact', { key }).catch(() => undefined)
  const isCompacting = typeof answer === 'object' && answer !== null && 'isCompacting' in answer && answer.isCompacting === true
  return isCompacting ? 'o Codex compacta a thread agora' : `o Codex não compactou agora (turno em curso ou thread fechada), e ${LIMIT_NOTE}`
}

export async function onCompact($: EngineInterface, e: SessionCompactInput, next: (e: SessionCompactInput) => Promise<SessionCompactResult>): Promise<SessionCompactResult> {
  if (!(await isGptCompaction($, e))) return next(e)
  if (e.trigger === 'precompute') return { skip: 'o loop do Codex não usa resumo prévio' }
  const tail = tailOf(e.messages)
  const key = e.agentId ?? `main:${await $.session.id()}`
  const codex = e.trigger === 'manual' ? await compactCodex($, key) : LIMIT_NOTE
  const text = `${COMPACT_MARK} ${e.messages.length - tail.length} mensagens anteriores saíram do transcript do Claude Code; a conversa inteira segue na thread do Codex, e ${codex}.`
  return { messages: [{ role: 'user', text, toolUses: [] }, ...tail] }
}

/** O `/clear` (e o `/resume` de outra conversa): o loop principal da sessão que acabou solta a thread do Codex. */
export async function onEnd($: EngineInterface, e: SessionEndInput, next: (e: SessionEndInput) => Promise<SessionEndResult>): Promise<SessionEndResult> {
  if (e.reason === 'clear' || e.reason === 'resume') {
    const key = `main:${e.sessionId}`
    forgetLoop(key)
    forgetNativeLoop(key)
    forgetLive(key)
    forgetContext(key)
    await forgetLoopCwd($, key)
    const bridge = liveBridge()
    if (bridge !== undefined) await bridgeCall($, bridge, '/forget', { session: e.sessionId }).catch(() => undefined)
  }
  return next(e)
}

/**
 * O fim do turno do Claude Code fecha o turno do Codex que ele abriu, se ainda corre ou espera para começar. O caso é o
 * Esc, e também o outro hook que encerrou o passo antes e o orçamento do hook. O motor corta o dispatch do passo: o
 * `$.http.fetch` que o passo faz depois falha com `user-cancel` sem sair, e o Codex seguia trabalhando (medido em
 * 25/10). O `turn.complete` é outro dispatch. Com o dono (`turnId`), a ponte não toca o turno seguinte, e ignora o
 * pedido quando o turno dele já fechou, como no fim normal.
 */
export async function onTurnEnd($: EngineInterface, e: TurnCompleteInput, next: (e: TurnCompleteInput) => Promise<TurnCompleteResult>): Promise<TurnCompleteResult> {
  const key = e.agentId ?? `main:${await $.session.id()}`
  const bridge = liveBridge()
  if (isGptLoop(key) && bridge !== undefined) await bridgeCall($, bridge, '/interrupt', { key, owner: e.turnId }).catch(() => undefined)
  return next(e)
}

/** Os hooks do caminho nativo além do passo; se um falhar, o evento segue como o Claude Code o decidiu. */
export function registerNative(on: On): void {
  on('turn.complete', onTurnEnd).catch(($, e, next) => next(e))
  on('session.append', { door: 'delivery' }, onDelivery).catch(($, e, next) => next(e))
  on('session.append', { door: 'attachment' }, onContext).catch(($, e, next) => next(e))
  on('session.append', { door: 'hook-context' }, onContext).catch(($, e, next) => next(e))
  on('prompt.submit', onSubmit).catch(($, e, next) => next(e))
  on('session.compact', onCompact).catch(($, e, next) => next(e))
  on('session.end', onEnd).catch(($, e, next) => next(e))
}
