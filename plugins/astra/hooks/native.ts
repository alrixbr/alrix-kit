import type { EngineInterface, SessionMessage, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { accepted, type Bridge, bridgeCall, bridgeReady, isSetupError } from './bridge-client'
import type { Catalog } from './catalog'
import { type LoopSetup, setupOf } from './native-agent'
import { contextText, dropContext, peekContext, reminderBlocks } from './native-context'
import { continuationOf, deliversByTool, lastAnswer } from './native-handback'
import { type Late, lateText, markGptLoop, putBack, resultsOfLastRound, takeNews } from './native-news'
import { clearLive, forgetSteered, markLive, withoutSteered } from './native-steer'
import { PULSE_MS, MAX_QUIET_MS, pulseLine } from './pulse'
import { closingText, nextIndex, noteLine, parseBatch, RELAY_START, type Relay, relayEvent, type ToolCall } from './relay'
import { HANDBACK_TOOL, withoutDemands, withoutMarks } from './request'

/**
 * O passo de um modelo do Codex (GPT-6 Astra, GPT-6.1 Sol) respondido pelo App Server, pela ponte da sessão: o texto e o
 * pensamento chegam ao vivo, os comandos do Codex rodam nele mesmo, e as ferramentas do Claude Code que ele pede saem
 * como `tool_use` do passo; o resultado volta ao Codex no passo seguinte, que continua o mesmo turno dele.
 */
export const isGptModel = (model: string): boolean => /^gpt-\d/.test(model)

const POLL_MS = 20_000
/** As ferramentas que esperam a pessoa: passam ao Claude Code na hora, sem segurar o turno do Codex. */
const WAITS_FOR_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])
const NO_RESULT = 'O Claude Code não devolveu resultado para esta ferramenta.'

type Step = Pick<TurnStepInput, 'turnId' | 'index' | 'model' | 'effort' | 'agentId'>
/** Uma chamada do Codex, pelo id que ela tem no transcript: o `callId` da ponte e o nome no Claude Code. */
type Asked = { callId: string; tool: string }
/** O turno do Codex que espera as ferramentas: o id dele, o cursor dos eventos e cada chamada. */
type Pending = { epoch: string; turnId: string; codexTurnId: string; cursor: number; startedAt: number; calls: ReadonlyMap<string, Asked> }
type Reading = { bridge: Bridge; e: Step; key: string; aborted: Promise<'aborted'> }
/** De onde ler o turno do Codex: o cursor dos eventos, quando o passo começou e o id do turno. */
type From = { cursor: number; startedAt: number; codexTurnId: string }

const pending = new Map<string, Pending>()
/** As ferramentas que a thread de cada loop recebeu ao abrir o turno: é por elas que uma chamada do Codex volta. */
const catalogs = new Map<string, Catalog>()

const RESTARTED = '[astra] A ponte do Codex reiniciou no meio deste turno, e o que ele pediu ficou sem continuação. Peça de novo.'
const NOTHING = '[astra] Não há pedido novo para o Codex neste passo.'
const STEERED = '[astra] O Codex recebeu este recado no turno anterior, enquanto trabalhava, e a resposta acima já o leva em conta.'

/** O `/clear`: o loop principal da sessão que acabou não continua turno nenhum. */
export function forgetNativeLoop(key: string): void {
  pending.delete(key)
  catalogs.delete(key)
}

/** As linhas do loop, sem os marcadores da compactação do mod e sem o pedido de entrega do motor. */
async function rowsOf($: EngineInterface, e: Step): Promise<readonly SessionMessage[]> {
  if (e.agentId === undefined) return withoutDemands(withoutMarks(await $.session.messages()))
  const read = await $.session.messages({ agentId: e.agentId })
  return Array.isArray(read) ? withoutDemands(withoutMarks(read)) : []
}

const toolUseId = (e: Step, position: number): string => `toolu_astra_${e.turnId.replace(/[^a-zA-Z0-9]/g, '')}_${e.index}_${position}`

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Os argumentos de uma chamada como objeto: o Codex os manda como JSON já lido, ou, às vezes, como texto JSON. */
function inputOf(args: unknown): Readonly<Record<string, unknown>> {
  const value = typeof args === 'string' ? parsed(args) : args
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

const seqOf = (value: unknown): number => (typeof value === 'object' && value !== null && 'seq' in value && typeof value.seq === 'number' ? value.seq : 0)

const isNewThread = (value: unknown): boolean => typeof value === 'object' && value !== null && 'isNew' in value && value.isNew === true

const turnIdOf = (value: unknown): string => (typeof value === 'object' && value !== null && 'turnId' in value && typeof value.turnId === 'string' ? value.turnId : '')

/**
 * O contexto do Claude Code para o turno (`native-context.ts`): numa thread nova, tudo o que a conversa tem no formato da
 * API; numa que já existe, o que chegou desde o turno anterior. `taken`: quantos da caixa o turno leva.
 */
async function contextOf($: EngineInterface, e: Step, key: string, isNew: boolean, news: readonly string[]): Promise<{ text: string; taken: number }> {
  const box = peekContext(key)
  if (!isNew) return { text: contextText(box, news), taken: box.length }
  const read = e.agentId === undefined ? await $.session.messages({ as: 'api' }) : await $.session.messages({ as: 'api', agentId: e.agentId })
  return { text: contextText(reminderBlocks(Array.isArray(read) ? read : []), news), taken: box.length }
}

/**
 * Abre o turno do Codex com o contexto do Claude Code, o pedido do usuário e o que chegou fora dele (`extra`); numa
 * thread nova, que não sabe da conversa, o pedido vai com o histórico. Devolve o id do turno e o cursor que a ponte deu
 * a ele, lido depois que o anterior fechou (o `done` de um turno que ainda se interrompia fica antes dele).
 */
async function begin($: EngineInterface, bridge: Bridge, e: Step, key: string, setup: LoopSetup, extra: readonly string[]): Promise<Omit<From, 'startedAt'>> {
  const { cwd, sandbox, developerInstructions, catalog } = setup
  const session = await $.session.id()
  const ensured = await bridgeCall($, bridge, '/threads/ensure', { key, session, cwd, model: e.model, sandbox, developerInstructions, dynamicTools: catalog.dynamicTools })
  catalogs.set(key, catalog)
  const isNew = isNewThread(ensured)
  const context = await contextOf($, e, key, isNew, extra)
  const lead = isNew && setup.history !== undefined ? setup.history : setup.text
  const text = [context.text, lead, ...extra].filter(part => part !== '').join('\n\n')
  const started = await bridgeCall($, bridge, '/turns', { key, text, model: e.model, effort: typeof e.effort === 'string' ? e.effort : undefined, owner: e.turnId })
  dropContext(key, context.taken)
  return { cursor: seqOf(started), codexTurnId: turnIdOf(started) }
}

function lateOf(waiting: Pending, rows: readonly SessionMessage[]): readonly (Late & { callId: string })[] {
  const results = rows.flatMap(row => row.toolResults ?? [])
  return [...waiting.calls].map(([id, asked]) => {
    const result = results.findLast(candidate => candidate.tool_use_id === id)
    return { ...asked, text: result?.text ?? NO_RESULT, isError: result?.isError ?? true }
  })
}

/**
 * Devolve ao Codex o resultado de cada ferramenta que ele pediu no passo anterior; o que a ponte já tinha passado ao
 * Claude Code (o 409) volta como tardio.
 */
async function deliver($: EngineInterface, bridge: Bridge, key: string, waiting: Pending, rows: readonly SessionMessage[]): Promise<readonly Late[]> {
  let late: readonly Late[] = []
  for (const { callId, tool, text, isError } of lateOf(waiting, rows)) {
    const isTaken = await accepted(bridgeCall($, bridge, '/tool-result', { key, callId, text, isError }))
    if (!isTaken) late = [...late, { tool, text, isError }]
  }
  return late
}

/** Entrada nova no turno em curso do Codex; false se ele já fechou. */
function steer($: EngineInterface, bridge: Bridge, key: string, text: string): Promise<boolean> {
  return accepted(bridgeCall($, bridge, '/steer', { key, text }))
}

/**
 * A entrega pelo SubagentHandback (`native-handback.ts`), no bloco `at`: `message` é a resposta inteira, e `shown`, o
 * texto que o passo mostrou ao lado. A chamada encerra o loop, e quem chamou recebe o relatório.
 */
function* handBack(e: Step, shown: string, message: string, at: number): Generator<TurnStepChunk, TurnStepResult> {
  const input = { message }
  yield { kind: 'tool', index: at, id: toolUseId(e, 0), name: HANDBACK_TOOL }
  yield { kind: 'input', index: at, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: shown, toolUses: [{ name: HANDBACK_TOOL, input }], stopReason: 'tool_use', usage: null }
}

/** O fim do passo com a resposta: em texto, ou, com `toolAt`, também pelo SubagentHandback nesse bloco. */
function* endTurn(e: Step, answer: string, text: string, index: number, toolAt?: number): Generator<TurnStepChunk, TurnStepResult> {
  if (text !== '') yield { kind: 'text', index, text }
  if (toolAt !== undefined) return yield* handBack(e, answer + text, answer + text, toolAt)
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: answer + text, toolUses: [], stopReason: 'end_turn', usage: null }
}

/** O turno do Codex terminou: o texto de fecho, se não terminou bem, e o fim do passo; `byTool`, com a entrega. */
function* finishTurn(e: Step, relay: Relay, byTool: boolean): Generator<TurnStepChunk, TurnStepResult> {
  const closing = closingText(relay)
  const lead = relay.answer.trim() === '' || closing === '' ? '' : '\n\n'
  const index = relay.open === 'text' ? relay.index : nextIndex(relay)
  const text = closing === '' ? '' : `${lead}${closing}`
  const toolAt = text === '' ? nextIndex(relay) : index + 1
  return yield* endTurn(e, relay.answer, text, index, byTool ? toolAt : undefined)
}

/** O passo que fecha sem o Codex (uma recusa, um aviso, a máquina sem o que ele precisa): a frase vai a quem chamou. */
async function* closeWith($: EngineInterface, e: Step, text: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  return yield* endTurn(e, '', text, 0, (await deliversByTool($, e)) ? 1 : undefined)
}

/**
 * A continuação sem nada novo para o Codex, com a resposta dele já pronta (a cobrança da entrega): a última resposta
 * vai de novo, pelo SubagentHandback onde ele é exigido, sem chamar o Codex outra vez.
 */
async function* answerAgain($: EngineInterface, e: Step, again: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (await deliversByTool($, e)) return yield* handBack(e, '', again, 0)
  return yield* endTurn(e, '', again, 0)
}

/** As ferramentas que o Codex pediu saem como chamadas do passo; o turno dele fica esperando os resultados. */
function* askTools(reading: Reading, relay: Relay, calls: readonly ToolCall[], kept: Omit<Pending, 'calls'>): Generator<TurnStepChunk, TurnStepResult> {
  const { e, key } = reading
  const first = nextIndex(relay)
  const uses = calls.map((call, position) => ({ id: toolUseId(e, position), call, input: inputOf(call.args) }))
  for (const [position, use] of uses.entries()) {
    yield { kind: 'tool', index: first + position, id: use.id, name: use.call.tool }
    yield { kind: 'input', index: first + position, json: JSON.stringify(use.input) }
  }
  pending.set(key, { ...kept, calls: new Map(uses.map(use => [use.id, { callId: use.call.callId, tool: use.call.tool }])) })
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: relay.answer, toolUses: uses.map(use => ({ name: use.call.tool, input: use.input })), stopReason: 'tool_use', usage: null }
}

/** As chamadas com o nome do Claude Code; a que não está no catálogo é recusada na hora, e o turno do Codex segue. */
async function knownCalls($: EngineInterface, reading: Reading, calls: readonly ToolCall[]): Promise<readonly ToolCall[]> {
  const names = catalogs.get(reading.key)?.names ?? new Map<string, string>()
  for (const call of calls.filter(candidate => !names.has(candidate.tool))) {
    await bridgeCall($, reading.bridge, '/tool-result', { key: reading.key, callId: call.callId, text: `A ferramenta ${call.tool} não existe nesta sessão do Claude Code.`, isError: true })
  }
  const known = calls.flatMap(call => {
    const name = names.get(call.tool)
    return name === undefined ? [] : [{ ...call, tool: name }]
  })
  // A pergunta à pessoa pode levar horas: o turno do Codex não fica preso nela, e a resposta chega depois. Se o repasse
  // falhar, a chamada fica retida até o prazo da ponte, como as outras.
  for (const call of known.filter(candidate => WAITS_FOR_PERSON.has(candidate.tool))) {
    await bridgeCall($, reading.bridge, '/handoff', { key: reading.key, callId: call.callId }).catch(() => undefined)
  }
  return known
}

async function poll($: EngineInterface, reading: Reading, cursor: number): Promise<ReturnType<typeof parseBatch> | 'aborted'> {
  const { bridge, key } = reading
  const read = bridgeCall($, bridge, `/events?key=${encodeURIComponent(key)}&after=${cursor}&waitMs=${POLL_MS}`).then(parseBatch)
  return Promise.race([read, reading.aborted])
}

/** O passo parou antes do Codex (Esc, o Codex calado além do teto, a ponte que falhou); `stopped` diz o que já saiu. */
type Stopped = { stopped: Relay; done: NonNullable<Relay['done']> }
/** O turno do Codex terminou (bem ou não): o passo fecha em `nativeStep`, que decide se entrega pelo SubagentHandback. */
type Finished = { finished: Relay }
/** A continuação sem nada novo, com a resposta já pronta: ela vai de novo (`answerAgain`). */
type Again = { again: string }
type Failure = { failure: string }

const QUIET = { status: 'failed', error: `o Codex ficou ${MAX_QUIET_MS / 60_000} min sem nenhum evento, e o turno foi interrompido` }
const isFailure = (value: unknown): value is Failure => typeof value === 'object' && value !== null && 'failure' in value

/**
 * O que a ponte respondeu, ou o motivo da falha. Depois do 1º pedaço o erro fecha o passo aqui, com o índice do relay:
 * o `.catch` do hook continuaria o stream escrevendo no índice 0, que já pode ser um bloco de pensamento.
 */
async function settled<T>(work: Promise<T>): Promise<T | Failure> {
  try {
    return await work
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
}

/** O erro de preparo da máquina vira `{ setup: frase }`; outro erro segue para o `.catch` do hook. */
async function setupOrThrow<T>(work: Promise<T>): Promise<T | { setup: string }> {
  try {
    return await work
  } catch (error) {
    if (isSetupError(error) && error instanceof Error) return { setup: error.message }
    throw error
  }
}

const brokeOff = (relay: Relay, failure: Failure): Stopped => ({ stopped: relay, done: { status: 'failed', error: `a ponte parou de responder no meio do turno (${failure.failure})` } })

/** Lê o turno do Codex a partir do cursor até ele terminar ou pedir ferramentas; calado, um sinal de vida por minuto. */
async function* readTurn($: EngineInterface, reading: Reading, from: From): AsyncGenerator<TurnStepChunk, TurnStepResult | Stopped | Finished> {
  const { e } = reading
  let relay = RELAY_START
  let cursor = from.cursor
  let heardAt = await $.clock.now()
  let notedAt = heardAt
  for (;;) {
    const batch = await settled(poll($, reading, cursor))
    if (batch === 'aborted') return { stopped: relay, done: { status: 'interrupted' } }
    if (isFailure(batch)) return brokeOff(relay, batch)
    cursor = batch.next
    for (const event of batch.events) {
      const out = relayEvent(relay, event)
      relay = out.relay
      yield* out.chunks
    }
    const now = await $.clock.now()
    if (batch.events.length > 0) heardAt = notedAt = now
    // O turno que não terminou bem pode não ter levado em conta o recado que recebeu por steer: ele segue o caminho normal.
    if (relay.done !== undefined && relay.done.status !== 'completed') forgetSteered(reading.key)
    if (relay.done !== undefined) return { finished: relay }
    const calls = relay.calls.length === 0 ? [] : await settled(knownCalls($, reading, relay.calls))
    if (isFailure(calls)) return brokeOff(relay, calls)
    if (calls.length > 0) return yield* askTools(reading, relay, calls, { epoch: reading.bridge.epoch, turnId: e.turnId, codexTurnId: from.codexTurnId, cursor, startedAt: from.startedAt })
    relay = { ...relay, calls: [] }
    if (now - heardAt >= MAX_QUIET_MS) return { stopped: relay, done: QUIET }
    if (now - notedAt < PULSE_MS) continue
    notedAt = now
    const out = noteLine(relay, pulseLine(now - from.startedAt, now - heardAt, relay.latest))
    relay = out.relay
    yield* out.chunks
  }
}

const abortedBy = (signal: AbortSignal): Promise<'aborted'> =>
  new Promise(resolve => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })

/**
 * O passo seguinte às ferramentas: os resultados vão ao turno que as pediu, e as entregas, por `turn/steer`, depois
 * deles. Devolve o cursor para seguir lendo o turno, ou o que precisa de um turno novo: o resultado que a ponte já
 * tinha passado ao Claude Code quando o turno fechou, ou todos, se a ponte reiniciou.
 */
async function continueTurn($: EngineInterface, bridge: Bridge, key: string, waiting: Pending, rows: readonly SessionMessage[], news: readonly string[]): Promise<From | readonly string[]> {
  if (waiting.epoch !== bridge.epoch) return [lateText(lateOf(waiting, rows)), ...news]
  const late = await deliver($, bridge, key, waiting, rows)
  const from = { cursor: waiting.cursor, startedAt: waiting.startedAt, codexTurnId: waiting.codexTurnId }
  const text = [lateText(late), ...news].filter(part => part !== '').join('\n\n')
  if (text === '' || (await steer($, bridge, key, text))) return from
  if (late.length > 0) return [lateText(late), ...news]
  // Os resultados entraram, e o turno fechou antes do recado: ele segue no próximo passo, e o fim do turno se lê.
  putBack(key, news)
  return from
}

/**
 * O passo do meio do turno sem nada novo para o Codex. Com um turno à espera que a ponte perdeu (ela trocou de época),
 * o aviso de que ela reiniciou; com a resposta do Codex já pronta (a cobrança da entrega, que não vai ao Codex), essa
 * resposta de novo; sem nenhuma das duas, o aviso de que não há pedido.
 */
function nothingNew(e: Step, bridge: Bridge, waiting: Pending | undefined, rows: readonly SessionMessage[]): string | Again {
  if (e.index === 0) return NOTHING
  if (waiting !== undefined && waiting.epoch !== bridge.epoch) return RESTARTED
  const again = lastAnswer(rows)
  return again === '' ? NOTHING : { again }
}

/** Onde o turno do Codex está: continuando depois das ferramentas, ou começando com o pedido novo. */
async function placeTurn($: EngineInterface, bridge: Bridge, e: Step, key: string, mainType: string | undefined, news: readonly string[]): Promise<From | string | Again> {
  const rows = await rowsOf($, e)
  const waiting = pending.get(key)
  pending.delete(key)
  const continued = waiting !== undefined && waiting.turnId === e.turnId ? await continueTurn($, bridge, key, waiting, rows, news) : undefined
  if (continued !== undefined && 'cursor' in continued) return continued
  // O turno anterior parou no meio (Esc, ou o "No" no diálogo de permissão, que encerra o turno do Claude Code): a
  // ponte o fecha antes de abrir o novo. O Codex registra a chamada como abortada, e o pedido novo chega com o marcador
  // de interrupção que o Claude Code põe na linha do usuário.
  if (continued === undefined && waiting !== undefined && waiting.epoch === bridge.epoch) await bridgeCall($, bridge, '/interrupt', { key })
  // Sem turno à espera no meio do turno do Claude Code (o mod recarregou): os resultados saem do transcript.
  const late = continued ?? (waiting === undefined && e.index > 0 ? [lateText(resultsOfLastRound(rows)), ...news] : news)
  // A continuação que um hook de parada abre depois da resposta (a cobrança da entrega, um hook que devolve o turno): a
  // mensagem dele não está nas linhas, só no formato da API. Ela abre um turno novo do Codex na mesma thread.
  const extra = waiting === undefined && e.index > 0 ? [...late, ...(await continuationOf($, e, late))] : late
  const setup = await setupOf($, { agentId: e.agentId, mainType }, rows)
  if (typeof setup === 'string') return setup
  // O turno que a fila abre com recados que o anterior já recebeu por steer: eles não vão de novo.
  const text = await withoutSteered(key, setup.text)
  if (text === '' && setup.text !== '' && extra.every(part => part === '')) return STEERED
  if ([text, ...extra].every(part => part === '')) return nothingNew(e, bridge, waiting, rows)
  return { ...(await begin($, bridge, e, key, { ...setup, text }, extra)), startedAt: await $.clock.now() }
}

/** O passo que falha ou recusa não leva as entregas ao Codex: elas voltam à caixa para o próximo. */
async function startOrResume($: EngineInterface, bridge: Bridge, e: Step, key: string, mainType: string | undefined): Promise<From | string | Again> {
  const news = takeNews(key)
  try {
    const from = await placeTurn($, bridge, e, key, mainType, news)
    if (typeof from === 'string' || 'again' in from) putBack(key, news)
    return from
  } catch (error) {
    putBack(key, news)
    throw error
  }
}

/** `mainType`: no passo do loop principal, o agente com que o processo foi lançado (o `launchOf` do register.ts). */
export async function* nativeStep($: EngineInterface, e: Step, signal: AbortSignal, mainType?: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const key = e.agentId ?? `main:${await $.session.id()}`
  markGptLoop(key)
  const opened = await setupOrThrow(bridgeReady($).then(async bridge => ({ bridge, from: await startOrResume($, bridge, e, key, mainType) })))
  // A máquina sem o que o Codex precisa (Node, Codex, login) ou a ponte que não abriu: a frase vai à pessoa como está.
  if ('setup' in opened) return yield* closeWith($, e, `[astra] ${opened.setup}`)
  const { bridge, from } = opened
  if (typeof from === 'string') return yield* closeWith($, e, from)
  if ('again' in from) return yield* answerAgain($, e, from.again)
  // Enquanto o turno do Codex corre (inclusive esperando as ferramentas do Claude Code), recado recebe steer na hora.
  markLive(key, { turnId: e.turnId, codexTurnId: from.codexTurnId })
  const reading: Reading = { bridge, e, key, aborted: abortedBy(signal) }
  const result = yield* readTurn($, reading, from)
  // As ferramentas que o Codex pediu: o turno dele segue vivo, esperando os resultados.
  if (!('stopped' in result) && !('finished' in result)) return result
  clearLive(key)
  // O turno do Codex terminou: a resposta sai em texto e, onde o Claude Code exige, também pelo SubagentHandback.
  if ('finished' in result) return yield* finishTurn(e, result.finished, await deliversByTool($, e))
  // Esc, o Codex calado além do teto ou a ponte que falhou: o turno dele fecha, e o passo termina com o que já saiu.
  // Depois do Esc o motor recusa o pedido deste dispatch: o `onTurnEnd` (native-session.ts) fecha o turno no lugar.
  forgetSteered(key)
  pending.delete(key)
  if (!signal.aborted) await bridgeCall($, bridge, '/interrupt', { key }).catch(() => undefined)
  return yield* finishTurn(e, { ...result.stopped, done: result.done }, !signal.aborted && (await deliversByTool($, e)))
}
