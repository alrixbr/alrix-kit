// App Server falso, só para os testes da ponte: o mesmo JSON-RPC por linha do `codex app-server` 0.169.0 (protocolo conferido em 18/11/2026), com respostas
// fixas, sem rede e sem conta. O roteiro de cada turno vem do texto do pedido; `FAKE_LOG` recebe cada pedido da ponte.
// `FAKE_IGNORE_TERM=1`: ignora o fim da entrada e o SIGTERM (só o encerramento à força o derruba). `FAKE_SLOW_INIT=1`: nunca responde o `initialize`.
// `FAKE_INTERRUPT_MS`: o turno interrompido só fecha depois desse tempo, como o Codex que aborta um script em curso.
// `FAKE_RESUME_FAIL=1`: o `thread/resume` recusa, como o rollout que sumiu. `FAKE_COMPACT_MS`: quanto a compactação dura
// (`never`: não acaba); `FAKE_COMPACT_STRAY=1`: antes do fim dela, chega o aviso atrasado de outro turno.
// `FAKE_ACCOUNT_FILE`: o `account/read` responde a conta (`{ email, planType }`) que o arquivo tem na hora.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

type Id = number | string
type Message = { id?: Id; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
type Answer = { result?: unknown; error?: { message?: string } }

const waiting = new Map<Id, (answer: Answer) => void>()
/** Os turnos em curso; o `turn/steer` entrega o texto ao turno que espera por ele (o cenário 'ouvir'). */
const active = new Map<string, { heard: string[]; listen?: (text: string) => void }>()
let serverIds = 0
let threads = 0
let turns = 0
let compactions = 0

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const notify = (method: string, params: object): void => send({ method, params })
const ask = (method: string, params: object): Promise<Answer> =>
  new Promise(resolve => {
    const id = `srv-${++serverIds}`
    waiting.set(id, resolve)
    send({ id, method, params })
  })
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** A resposta do turno; com `isOpen`, o turno fica aberto depois dela, até o `turn/interrupt`. */
function speak(threadId: string, turnId: string, text: string, isOpen = false): void {
  const item = { type: 'agentMessage', id: `m-${turnId}`, phase: 'final_answer', text: '' }
  notify('item/started', { threadId, turnId, item })
  notify('item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: text })
  notify('item/completed', { threadId, turnId, item: { ...item, text } })
  if (isOpen) return
  active.delete(turnId)
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null } })
}

const toolText = (answer: Answer): string => {
  const result = answer.result as { contentItems?: { text?: string }[]; success?: boolean } | undefined
  return `${result?.contentItems?.[0]?.text ?? '?'} (${String(result?.success)})`
}

/** O próximo texto que o `turn/steer` mandar a este turno. */
const heard = (turnId: string): Promise<string> =>
  new Promise(resolve => {
    const turn = active.get(turnId)
    const early = turn?.heard[0]
    if (turn === undefined || early !== undefined) return resolve(early ?? '')
    active.set(turnId, { ...turn, listen: resolve })
  })

async function play(threadId: string, turnId: string, text: string): Promise<void> {
  const call = (callId: string, consulta: string): Promise<Answer> =>
    ask('item/tool/call', { threadId, turnId, callId, namespace: null, tool: 'mcp_notas__buscar', arguments: { consulta } })
  if (text === 'ola') {
    notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'c1', phase: 'commentary', text: '' } })
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'c1', delta: 'Olhando.' })
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0 } })
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, totalTokens: 12 }, modelContextWindow: 272000 } })
    return speak(threadId, turnId, 'Oi')
  }
  if (text === 'ferramenta') return speak(threadId, turnId, `Recebi: ${toolText(await call('call-1', 'astra'))}`)
  // 'ouvir': depois da ferramenta, espera uma entrada pelo `turn/steer` e responde com as duas.
  if (text === 'ouvir') {
    const tool = toolText(await call('call-1', 'astra'))
    return speak(threadId, turnId, `Recebi: ${tool}; ouvi: ${await heard(turnId)}`)
  }
  // 'teima': depois da 1ª ferramenta pede outra, responde as duas e não fecha o turno.
  if (text === 'teima') {
    const first = toolText(await call('call-1', 'a'))
    const second = toolText(await call('call-2', 'b'))
    return speak(threadId, turnId, `1: ${first}; 2: ${second}`, true)
  }
  if (text === 'duas') {
    const first = call('call-a', 'a')
    await pause(100)
    const second = call('call-b', 'b')
    return speak(threadId, turnId, `${toolText(await first)} e ${toolText(await second)}`)
  }
  if (text === 'hora') {
    const answer = await ask('currentTime/read', { threadId })
    return speak(threadId, turnId, `hora ${typeof (answer.result as { currentTimeAt?: unknown } | undefined)?.currentTimeAt}`)
  }
  if (text === 'aprovacao') {
    const answer = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'x', command: 'rm -rf /' })
    return speak(threadId, turnId, `recusado: ${answer.error?.message ?? 'não'}`)
  }
  // 'presa': a ferramenta fica sem resposta útil, e só o `turn/interrupt` fecha o turno.
  if (text === 'presa') return void call('call-1', 'astra')
  if (text === 'cair') process.exit(3)
  // 'espera' e o resto: o turno fica aberto até o `turn/interrupt`.
}

/** Como o 0.169: só o turno em curso, pelo `expectedTurnId`, recebe a entrada. */
function steer(id: Id | undefined, params: Record<string, unknown>): void {
  const turnId = String(params.expectedTurnId)
  const turn = active.get(turnId)
  if (turn === undefined) return send({ id, error: { code: -32603, message: 'failed to steer turn: no active turn to steer' } })
  const text = (params.input as { text?: string }[] | undefined)?.[0]?.text ?? ''
  send({ id, result: { turnId } })
  if (turn.listen !== undefined) turn.listen(text)
  else active.set(turnId, { heard: [...turn.heard, text] })
}

/**
 * A compactação roda como turno próprio, fora dos turnos do mod, e fecha depois de `FAKE_COMPACT_MS` (`never`: não
 * fecha). `FAKE_COMPACT_STRAY=1`: antes, chega o `turn/completed` atrasado de outro turno.
 */
function compact(id: Id | undefined, threadId: string): void {
  const turnId = `compact-${++compactions}`
  send({ id, result: {} })
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
  if (process.env.FAKE_COMPACT_STRAY === '1') notify('turn/completed', { threadId, turn: { id: 'turno-velho', status: 'interrupted', error: null } })
  notify('item/started', { threadId, turnId, item: { type: 'contextCompaction', id: `cc-${compactions}` } })
  if (process.env.FAKE_COMPACT_MS === 'never') return
  setTimeout(() => {
    notify('item/completed', { threadId, turnId, item: { type: 'contextCompaction', id: `cc-${compactions}` } })
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null } })
  }, Number(process.env.FAKE_COMPACT_MS ?? '200'))
}

function answer(message: Message): void {
  const { id, method, params = {} } = message
  if (process.env.FAKE_LOG !== undefined) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ method, params })}\n`)
  if (method === 'initialize' && process.env.FAKE_SLOW_INIT === '1') return
  if (method === 'initialize') return send({ id, result: { userAgent: 'alrix_cc_bridge/0.169.0 (fake)', codexHome: '/fake', platformFamily: 'unix', platformOs: 'linux' } })
  if (method === 'account/read') {
    const file = process.env.FAKE_ACCOUNT_FILE
    const login = file !== undefined && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as object) : { email: 'fake@example.invalid', planType: 'pro' }
    const account = process.env.FAKE_ACCOUNT === 'apikey' ? { type: 'apiKey' } : { type: 'chatgpt', ...login }
    return send({ id, result: { account, requiresOpenaiAuth: false } })
  }
  if (method === 'thread/start') return send({ id, result: { thread: { id: `thr-${++threads}` }, model: params.model } })
  if (method === 'thread/resume' && process.env.FAKE_RESUME_FAIL === '1') return send({ id, error: { code: -32600, message: `fake: no rollout found for thread id ${String(params.threadId)}` } })
  if (method === 'thread/resume') return send({ id, result: { thread: { id: params.threadId }, model: params.model } })
  if (method === 'thread/unsubscribe') return send({ id, result: { status: 'unsubscribed' } })
  if (method === 'thread/compact/start') return compact(id, String(params.threadId))
  if (method === 'turn/start') {
    const turnId = `turn-${++turns}`
    active.set(turnId, { heard: [] })
    // `FAKE_START_MS`: o turno já corre, e a resposta com o id chega depois desse tanto.
    const reply = (): void => send({ id, result: { turn: { id: turnId, status: 'inProgress' } } })
    if (Number(process.env.FAKE_START_MS ?? '0') > 0) setTimeout(reply, Number(process.env.FAKE_START_MS))
    else reply()
    const input = params.input as { text?: string }[] | undefined
    setImmediate(() => void play(String(params.threadId), turnId, input?.[0]?.text ?? ''))
    return
  }
  if (method === 'turn/steer') return steer(id, params)
  if (method === 'turn/interrupt') {
    send({ id, result: {} })
    active.delete(String(params.turnId))
    const close = (): void => notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', error: null } })
    const delay = Number(process.env.FAKE_INTERRUPT_MS ?? '0')
    if (delay > 0) setTimeout(close, delay)
    else close()
    return
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `fake: ${String(method)}` } })
}

// Como se espera do App Server: sai quando a entrada fecha (a ponte que fecha, ou que morreu). `FAKE_IGNORE_TERM=1`
// ignora também isso, e só o encerramento à força o derruba.
const isStubborn = process.env.FAKE_IGNORE_TERM === '1'
if (isStubborn) process.on('SIGTERM', () => undefined)
if (process.env.FAKE_LOG !== undefined) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ method: 'pid', params: { pid: process.pid } })}\n`)
const lines = createInterface({ input: process.stdin })
lines.on('close', () => {
  if (isStubborn) setInterval(() => undefined, 60_000)
  else process.exit(0)
})
lines.on('line', line => {
  const message = JSON.parse(line) as Message
  if (message.method === undefined && message.id !== undefined) {
    waiting.get(message.id)?.({ result: message.result, error: message.error })
    waiting.delete(message.id)
    return
  }
  if (message.method !== 'initialized') answer(message)
})
