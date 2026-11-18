// As threads do App Server, uma por loop do Claude Code (`key`: o loop principal ou um subagente), e os eventos de
// cada turno, que o mod lê por long-poll a partir de um cursor (`seq`). Uma chamada de ferramenta do Claude Code fica
// pendente aqui, com o turno do Codex parado, até o mod devolver o resultado no passo seguinte; passado o `holdMs`, a
// ponte a responde ela mesma, e o resultado chega depois ao Codex por `turn/steer` ou num turno novo.
import type { AppServer, ServerEvents } from './appserver.mts'
import type { Bindings } from './bindings.mts'
import { ensureThread } from './ensure.mts'
import { translate } from './events.mts'
import { type BridgeEvent, type Fields, fieldsOf, type NewEvent, recordOf, type RpcId, textOf } from './proto.mts'

const MAX_EVENTS = 2_000
/** Chamadas em paralelo chegam em sequência: espera-se este tanto antes de entregar a primeira ao mod. */
const BATCH_MS = 250
const INTERRUPT_WAIT_MS = 5_000
/**
 * O turno novo espera a compactação pedida pelo `/compact` acabar, como o TUI do Codex, até este tanto; passado o prazo,
 * segue sem ela.
 */
export const COMPACT_WAIT_MS = 10 * 60_000
/** Quanto uma ferramenta do Claude Code fica retida antes de a ponte passá-la ao Claude Code (blueprint §4). */
export const HOLD_MS = 120_000
/** Depois de passar a chamada, o turno que não fecha neste tempo, sem outra chamada pendente, é interrompido. */
const CLOSE_AFTER_HANDOFF_MS = 10_000
const INTERRUPTED = 'O usuário interrompeu o turno no Claude Code antes desta ferramenta responder.'
const handoffText = (tool: string): string =>
  `${tool} segue em execução no Claude Code. O resultado chega numa mensagem nova, depois que este turno terminar. Encerre o turno agora, sem chamar outra ferramenta.`
const AFTER_HANDOFF = 'Este turno já foi passado ao Claude Code. Encerre o turno agora, sem chamar outra ferramenta: o resultado chega numa mensagem nova.'

export type ThreadSpec = {
  key: string
  cwd: string
  model: string
  /** A sessão do Claude Code dona do loop: com ela, a thread fica gravada no binding e é retomada por ele. */
  session?: string
  /**
   * O sandbox que o mod escolheu para o loop (`hooks/native-agent.ts`); sem ele, `workspace-write`. O acesso total só
   * chega quando a pessoa ligou a opção `fullAccess` do astra.
   */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  developerInstructions?: string
  dynamicTools: readonly unknown[]
  config?: Fields
}

/** Uma chamada de ferramenta do Claude Code à espera do resultado. */
type Call = { rpc: RpcId; tool: string }

export type Thread = {
  threadId: string
  cwd: string
  session?: string
  fingerprint: string
  /** A conta do App Server que abriu a thread: a thread de uma conta não é retomada na outra. */
  account: string
  /** O App Server que abriu a thread caiu: a próxima `ensure` a retoma ou abre outra. */
  isStale: boolean
  isRunning: boolean
  turnId?: string
  /** O turno do Claude Code que abriu o turno em curso: o `/interrupt` com o dono fecha só o dele. */
  owner?: string
  /** O turno em curso já passou uma chamada ao Claude Code: chamada nova é recusada até ele fechar. */
  isHandedOff: boolean
  /** A compactação do `thread/compact/start` roda como turno próprio do App Server, fora dos eventos do mod. */
  isCompacting: boolean
  /** O turno da compactação, pelo `turn/started` dele: só o `turn/completed` com este id a encerra. */
  compactTurnId?: string
  seq: number
  events: readonly BridgeEvent[]
  calls: ReadonlyMap<string, Call>
  phases: ReadonlyMap<string, string>
  streamed: ReadonlySet<string>
  batchUntil: number
}

export type Batch = { events: readonly BridgeEvent[]; next: number }

export type Ensured = { threadId: string; isNew: boolean }

/**
 * O turno aberto e o cursor dele: o último `seq` antes do `turn/start`, lido depois que o turno anterior fechou. O
 * `done` de um turno que ainda se interrompia cai antes dele, e não no turno novo.
 */
export type Started = { turnId: string; seq: number }

export type Threads = ServerEvents & {
  ensure: (spec: ThreadSpec) => Promise<Ensured>
  startTurn: (key: string, text: string, model: string, effort?: string, owner?: string) => Promise<Started>
  events: (key: string, after: number, waitMs: number, gone: AbortSignal) => Promise<Batch | undefined>
  answer: (key: string, callId: string, text: string, isError: boolean) => boolean
  /** Passa a chamada ao Claude Code na hora (o `AskUserQuestion`, cuja resposta pode levar horas). */
  handOff: (key: string, callId: string) => boolean
  /**
   * Entrada nova no turno em curso; false sem turno em curso, se o App Server recusou ou se o turno em curso não é o
   * `turnId` que o mod indicou (o recado era daquele turno, e o seguinte o recebe pelo caminho normal).
   */
  steer: (key: string, text: string, turnId?: string) => Promise<boolean>
  /** Com `owner`, só o turno que aquele turno do Claude Code abriu, em curso ou ainda à espera de começar. */
  interrupt: (key: string, owner?: string) => Promise<void>
  /** O `/clear`: solta do App Server as threads paradas da sessão; o binding delas fica para um `--resume`. */
  forget: (session: string) => number
  compact: (key: string) => Promise<boolean>
  /** Algum turno ou compactação em curso: a ponte não sai por ociosidade nem troca de App Server. */
  isBusy: () => boolean
  count: () => number
}

export type ThreadOptions = { bindings?: Bindings; holdMs?: number; compactWaitMs?: number }

/** O estado da ponte e as operações básicas sobre ele, que cada operação do contrato usa. */
export type Context = {
  byKey: Map<string, Thread>
  keyOf: Map<string, string>
  waiters: Map<string, Set<() => void>>
  /** A interrupção em curso de cada thread. */
  closing: Map<string, Promise<void>>
  /** O `/turns` de cada thread que ainda não abriu o turno, com o dono: o `/interrupt` dele o cancela. */
  starting: Map<string, Start>
  /** O prazo de cada chamada retida, por `holdKey`. */
  holds: Map<string, NodeJS.Timeout>
  holdMs: number
  compactWaitMs: number
  bindings?: Bindings
  change: (key: string, patch: (thread: Thread) => Thread) => void
  push: (key: string, events: readonly NewEvent[]) => void
  appServer: () => Promise<AppServer>
  live: () => AppServer | undefined
  setLive: (server: AppServer | undefined) => void
}

type Start = { owner?: string; stop: AbortController }

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => new Map([...map].filter(([known]) => known !== key))
const holdKey = (key: string, callId: string): string => `${key}\u0000${callId}`

function release(ctx: Context, key: string, callIds: Iterable<string>): void {
  for (const callId of callIds) {
    clearTimeout(ctx.holds.get(holdKey(key, callId)))
    ctx.holds.delete(holdKey(key, callId))
  }
}

function context(server: () => Promise<AppServer>, options: ThreadOptions): Context {
  const byKey = new Map<string, Thread>()
  const waiters = new Map<string, Set<() => void>>()
  let current: AppServer | undefined
  const change: Context['change'] = (key, patch) => {
    const thread = byKey.get(key)
    if (thread !== undefined) byKey.set(key, patch(thread))
  }
  const push: Context['push'] = (key, events) => {
    if (events.length === 0) return
    change(key, thread => {
      const sequenced = events.map((event, position) => ({ ...event, seq: thread.seq + position + 1 }) as BridgeEvent)
      const batchUntil = events.some(event => event.kind === 'toolCall') ? Date.now() + BATCH_MS : thread.batchUntil
      return { ...thread, seq: thread.seq + events.length, events: [...thread.events, ...sequenced].slice(-MAX_EVENTS), batchUntil }
    })
    for (const resolve of waiters.get(key) ?? []) resolve()
    waiters.delete(key)
  }
  const appServer = async (): Promise<AppServer> => {
    current = await server()
    return current
  }
  return {
    byKey, keyOf: new Map(), waiters, closing: new Map(), starting: new Map(), holds: new Map(), holdMs: options.holdMs ?? HOLD_MS,
    compactWaitMs: options.compactWaitMs ?? COMPACT_WAIT_MS, bindings: options.bindings,
    change, push, appServer, live: () => current, setLive: next => (current = next),
  }
}

/** Um aviso que chega fora do turno em curso (de um turno já fechado ou interrompido) não entra nos eventos. */
function isStray(thread: Thread, params: Fields): boolean {
  const turnId = textOf(params, 'turnId') ?? textOf(recordOf(params, 'turn'), 'id')
  return !thread.isRunning || (thread.turnId !== undefined && turnId !== undefined && turnId !== thread.turnId)
}

/**
 * Os avisos do turno da compactação, que não entram nos eventos do mod: o `turn/started` dá o id, e só o `turn/completed`
 * com ele a encerra (o de um turno anterior que fechou tarde não).
 */
function onCompaction(ctx: Context, key: string, thread: Thread, method: string, params: Fields): void {
  const turnId = textOf(recordOf(params, 'turn'), 'id') ?? textOf(params, 'turnId')
  if (method === 'turn/started' && thread.compactTurnId === undefined) ctx.change(key, current => ({ ...current, compactTurnId: turnId }))
  if (method === 'turn/completed' && turnId !== undefined && turnId === thread.compactTurnId) endCompaction(ctx, key)
}

function onNotification(ctx: Context, method: string, params: Fields): void {
  const key = ctx.keyOf.get(textOf(params, 'threadId') ?? '')
  const thread = key === undefined ? undefined : ctx.byKey.get(key)
  if (key === undefined || thread === undefined) return
  if (thread.isCompacting && !thread.isRunning) return onCompaction(ctx, key, thread, method, params)
  if (isStray(thread, params)) return
  const step = translate(method, params, thread.phases, thread.streamed)
  if (step.isTurnOver) release(ctx, key, thread.calls.keys())
  ctx.change(key, current => ({
    ...current,
    phases: step.phase === undefined ? current.phases : new Map([...current.phases, step.phase]),
    streamed: step.streamed === undefined ? current.streamed : new Set([...current.streamed, step.streamed]),
    ...(step.isTurnOver ? { isRunning: false, turnId: undefined, isHandedOff: false, calls: new Map() } : {}),
  }))
  ctx.push(key, step.events)
}

/** A chamada de ferramenta do Claude Code fica retida até o resultado ou até o `holdMs`; depois de um repasse, é recusada. */
function onToolCall(ctx: Context, id: RpcId, key: string, params: Fields): void {
  const callId = textOf(params, 'callId') ?? ''
  const tool = textOf(params, 'tool') ?? ''
  if (ctx.byKey.get(key)?.isHandedOff === true) return ctx.live()?.respond(id, { contentItems: [{ type: 'inputText', text: AFTER_HANDOFF }], success: false })
  ctx.change(key, thread => ({ ...thread, calls: new Map([...thread.calls, [callId, { rpc: id, tool }]]) }))
  ctx.holds.set(holdKey(key, callId), setTimeout(() => handOff(ctx, key, callId), ctx.holdMs).unref())
  ctx.push(key, [{ kind: 'toolCall', callId, tool, args: params.arguments ?? {} }])
}

function onRequest(ctx: Context, id: RpcId, method: string, params: Fields): void {
  const key = ctx.keyOf.get(textOf(params, 'threadId') ?? '')
  if (method === 'item/tool/call' && key !== undefined && textOf(params, 'callId') !== undefined) return onToolCall(ctx, id, key, params)
  if (method === 'currentTime/read') return ctx.live()?.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) })
  ctx.live()?.refuse(id, `a ponte do Claude Code não atende ${method}`)
}

/** O App Server caiu: o turno em curso falha com o motivo, e cada thread fica para ser retomada ou aberta de novo. */
function onExit(ctx: Context, reason: string): void {
  ctx.setLive(undefined)
  for (const [key, thread] of ctx.byKey) {
    release(ctx, key, thread.calls.keys())
    if (thread.isRunning) ctx.push(key, [{ kind: 'error', message: reason, willRetry: false }, { kind: 'done', status: 'failed', error: reason }])
    ctx.change(key, current => ({ ...current, isStale: true, isRunning: false, turnId: undefined, isHandedOff: false, isCompacting: false, compactTurnId: undefined, calls: new Map() }))
  }
}

/** A compactação acabou: o turno que esperava por ela segue. */
function endCompaction(ctx: Context, key: string): void {
  ctx.change(key, current => ({ ...current, isCompacting: false, compactTurnId: undefined }))
  for (const resolve of ctx.waiters.get(key) ?? []) resolve()
  ctx.waiters.delete(key)
}

/** Passado o prazo sem o fim da compactação (o aviso se perdeu), a thread volta a aceitar turno, e este segue. */
async function awaitCompaction(ctx: Context, key: string, cancel: AbortSignal): Promise<void> {
  const deadline = Date.now() + ctx.compactWaitMs
  while (ctx.byKey.get(key)?.isCompacting === true && Date.now() < deadline && !cancel.aborted) await nextChange(ctx, key, deadline - Date.now(), cancel)
  if (ctx.byKey.get(key)?.isCompacting === true && !cancel.aborted) endCompaction(ctx, key)
}

/**
 * Um turno novo na thread do loop. Enquanto ele espera (o anterior fechar, a compactação acabar), o `/interrupt` do
 * dono o cancela: o Esc durante a espera não deixa um turno começar depois, sem ninguém lendo.
 */
async function startTurn(ctx: Context, key: string, text: string, model: string, effort?: string, owner?: string): Promise<Started> {
  const start = { owner, stop: new AbortController() }
  ctx.starting.set(key, start)
  try {
    return await openTurn(ctx, key, { text, model, effort, owner }, start.stop.signal)
  } finally {
    if (ctx.starting.get(key) === start) ctx.starting.delete(key)
  }
}

/** O anterior, se ficou aberto (o Esc no meio de uma ferramenta), fecha antes; a compactação em curso acaba antes. */
async function openTurn(ctx: Context, key: string, ask: { text: string; model: string; effort?: string; owner?: string }, cancel: AbortSignal): Promise<Started> {
  if (ctx.byKey.get(key)?.isRunning === true) await interruptTurn(ctx, key)
  await awaitCompaction(ctx, key, cancel)
  if (cancel.aborted) throw new Error('o turno foi interrompido antes de começar')
  const thread = ctx.byKey.get(key)
  if (thread === undefined || thread.isStale) throw new Error(`thread desconhecida: ${key}`)
  if (thread.isRunning) throw new Error('o turno anterior do Codex não fechou depois do pedido de interrupção')
  ctx.change(key, current => ({ ...current, isRunning: true, isHandedOff: false, owner: ask.owner }))
  try {
    const server = await ctx.appServer()
    const input = [{ type: 'text', text: ask.text, text_elements: [] }]
    const answer = await server.request('turn/start', { threadId: thread.threadId, input, model: ask.model, effort: ask.effort ?? null })
    const turnId = textOf(recordOf(fieldsOf(answer), 'turn'), 'id') ?? ''
    // O turno pode ter fechado antes da resposta chegar: aí não há o que marcar.
    ctx.change(key, current => (current.isRunning ? { ...current, turnId } : current))
    // O `/interrupt` do dono chegou durante o `turn/start`, ainda sem o id para pedir: o turno fecha agora.
    if (cancel.aborted && turnId !== '') await server.request('turn/interrupt', { threadId: thread.threadId, turnId }).catch(() => undefined)
    return { turnId, seq: thread.seq }
  } catch (error) {
    ctx.change(key, current => ({ ...current, isRunning: false }))
    throw error
  }
}

function answerCall(ctx: Context, key: string, callId: string, text: string, isError: boolean): boolean {
  const call = ctx.byKey.get(key)?.calls.get(callId)
  const server = ctx.live()
  if (call === undefined || server === undefined) return false
  release(ctx, key, [callId])
  server.respond(call.rpc, { contentItems: [{ type: 'inputText', text }], success: !isError })
  ctx.change(key, thread => ({ ...thread, calls: without(thread.calls, callId) }))
  return true
}

/**
 * A ponte responde ela mesma à chamada que o Claude Code ainda roda, e o turno do Codex se encerra; o resultado de
 * verdade, quando chegar, o `/tool-result` recusa (409), e o mod o leva por `turn/steer` ou num turno novo.
 */
function handOff(ctx: Context, key: string, callId: string): boolean {
  const thread = ctx.byKey.get(key)
  const call = thread?.calls.get(callId)
  const server = ctx.live()
  if (thread === undefined || call === undefined || server === undefined) return false
  release(ctx, key, [callId])
  server.respond(call.rpc, { contentItems: [{ type: 'inputText', text: handoffText(call.tool) }], success: true })
  ctx.change(key, current => ({ ...current, calls: without(current.calls, callId), isHandedOff: true }))
  const turnId = thread.turnId
  setTimeout(() => {
    const now = ctx.byKey.get(key)
    if (now?.isRunning === true && now.isHandedOff && now.turnId === turnId && now.calls.size === 0) void interruptTurn(ctx, key).catch(() => undefined)
  }, CLOSE_AFTER_HANDOFF_MS).unref()
  return true
}

/** A entrada que o turno aceitou o desarma do repasse: ele segue trabalhando nela e pode chamar ferramentas de novo. */
async function steerTurn(ctx: Context, key: string, text: string, turnId?: string): Promise<boolean> {
  const thread = ctx.byKey.get(key)
  const server = ctx.live()
  if (thread === undefined || !thread.isRunning || thread.turnId === undefined || server === undefined) return false
  if (turnId !== undefined && turnId !== thread.turnId) return false
  const input = [{ type: 'text', text, text_elements: [] }]
  const isSteered = await server.request('turn/steer', { threadId: thread.threadId, expectedTurnId: thread.turnId, input }).then(() => true, () => false)
  if (isSteered) ctx.change(key, current => (current.turnId === thread.turnId ? { ...current, isHandedOff: false } : current))
  return isSteered
}

/**
 * Solta as threads paradas da sessão; a que ainda roda (um subagente em segundo plano) fica. Responde na hora: o
 * `session.end` do `/clear` tem 1,5 s para tudo.
 */
function forgetSession(ctx: Context, session: string): number {
  const idle = [...ctx.byKey].filter(([, thread]) => thread.session === session && !thread.isRunning)
  for (const [key, thread] of idle) {
    ctx.byKey.delete(key)
    ctx.keyOf.delete(thread.threadId)
    void ctx.live()?.request('thread/unsubscribe', { threadId: thread.threadId }).catch(() => undefined)
  }
  return idle.length
}

/**
 * O `/compact` do Claude Code. O App Server interrompe o turno ativo para compactar (`abort_all_tasks`): com um turno em
 * curso, não se compacta, e o limite de 400.000 da thread segue valendo.
 */
async function compactThread(ctx: Context, key: string): Promise<boolean> {
  const thread = ctx.byKey.get(key)
  const server = ctx.live()
  if (thread === undefined || thread.isStale || thread.isRunning || thread.isCompacting || server === undefined) return false
  ctx.change(key, current => ({ ...current, isCompacting: true }))
  const isStarted = await server.request('thread/compact/start', { threadId: thread.threadId }).then(() => true, () => false)
  if (!isStarted) endCompaction(ctx, key)
  return isStarted
}

function nextChange(ctx: Context, key: string, ms: number, gone: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer)
      gone.removeEventListener('abort', done)
      ctx.waiters.get(key)?.delete(done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, ms))
    gone.addEventListener('abort', done, { once: true })
    ctx.waiters.set(key, new Set([...(ctx.waiters.get(key) ?? []), done]))
  })
}

/** Os eventos depois do cursor: na hora, se já há; senão, assim que chegarem ou no fim do prazo, vazio. */
async function waitEvents(ctx: Context, key: string, after: number, waitMs: number, gone: AbortSignal): Promise<Batch | undefined> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const thread = ctx.byKey.get(key)
    if (thread === undefined) return undefined
    const fresh = thread.events.filter(event => event.seq > after)
    const now = Date.now()
    const isSettled = fresh.length > 0 && now >= thread.batchUntil
    if (isSettled || now >= deadline || gone.aborted) return { events: fresh, next: fresh.at(-1)?.seq ?? after }
    await nextChange(ctx, key, (fresh.length > 0 ? Math.min(deadline, thread.batchUntil) : deadline) - now, gone)
  }
}

/**
 * Uma interrupção por thread: o `/turns` que chega com a do `/interrupt` em curso espera a mesma, sem outro
 * `turn/interrupt` (cujo aviso de fim chegaria com o turno novo já aberto).
 */
function interruptTurn(ctx: Context, key: string): Promise<void> {
  const current = ctx.closing.get(key)
  if (current !== undefined) return current
  const closing = closeTurn(ctx, key).finally(() => ctx.closing.delete(key))
  ctx.closing.set(key, closing)
  return closing
}

/**
 * O `/interrupt`. Com `owner` (o fim do turno do Claude Code), só o turno que ele abriu: cancela o `/turns` dele que
 * ainda espera e fecha o turno dele em curso, nunca o do turno seguinte. Sem `owner`, o turno em curso da thread.
 */
function interruptOwned(ctx: Context, key: string, owner?: string): Promise<void> {
  const start = ctx.starting.get(key)
  if (owner !== undefined && start?.owner === owner) start.stop.abort()
  if (owner !== undefined && ctx.byKey.get(key)?.owner !== owner) return Promise.resolve()
  return interruptTurn(ctx, key)
}

/** Recusa as ferramentas pendentes, pede `turn/interrupt` e espera o turno fechar, no máximo `INTERRUPT_WAIT_MS`. */
async function closeTurn(ctx: Context, key: string): Promise<void> {
  const thread = ctx.byKey.get(key)
  const server = ctx.live()
  if (thread === undefined || !thread.isRunning || server === undefined) return
  release(ctx, key, thread.calls.keys())
  for (const call of thread.calls.values()) server.respond(call.rpc, { contentItems: [{ type: 'inputText', text: INTERRUPTED }], success: false })
  ctx.change(key, current => ({ ...current, calls: new Map() }))
  if (thread.turnId !== undefined) await server.request('turn/interrupt', { threadId: thread.threadId, turnId: thread.turnId }).catch(() => undefined)
  const deadline = Date.now() + INTERRUPT_WAIT_MS
  const never = new AbortController().signal
  while (ctx.byKey.get(key)?.isRunning === true && Date.now() < deadline) await nextChange(ctx, key, deadline - Date.now(), never)
}

export function createThreads(server: () => Promise<AppServer>, options: ThreadOptions = {}): Threads {
  const ctx = context(server, options)
  return {
    onNotification: (method, params) => onNotification(ctx, method, params),
    onRequest: (id, method, params) => onRequest(ctx, id, method, params),
    onExit: reason => onExit(ctx, reason),
    ensure: spec => ensureThread(ctx, spec),
    startTurn: (key, text, model, effort, owner) => startTurn(ctx, key, text, model, effort, owner),
    events: (key, after, waitMs, gone) => waitEvents(ctx, key, after, waitMs, gone),
    answer: (key, callId, text, isError) => answerCall(ctx, key, callId, text, isError),
    handOff: (key, callId) => handOff(ctx, key, callId),
    steer: (key, text, turnId) => steerTurn(ctx, key, text, turnId),
    interrupt: (key, owner) => interruptOwned(ctx, key, owner),
    forget: session => forgetSession(ctx, session),
    compact: key => compactThread(ctx, key),
    isBusy: () => [...ctx.byKey.values()].some(thread => thread.isRunning || thread.isCompacting),
    count: () => ctx.byKey.size,
  }
}
