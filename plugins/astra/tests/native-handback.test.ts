import type { On, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { partsOf, withoutDemands } from '../hooks/request'
import { agentInfo, bodyText } from './fixtures/agent-info'

// A entrega do relatório pelo SubagentHandback e a continuação de turno, com dados sintéticos e a ponte falsa de
// native-f4.test.ts. Os textos do motor são os da prova ao vivo de 18/11 (Claude Code 2.1.327, modo auto, astra:sol).

const SESSION = 'synthetic-session'
const MAIN = `main:${SESSION}`
const PROMPT = 'Responda só a palavra ok, sem rodar comando e sem usar ferramenta.'
/** O lembrete que o motor põe no começo do loop de um subagente que entrega por ferramenta (linha 3 da transcrição). */
const HANDBACK_REMINDER =
  '<system-reminder>\nYour final report is delivered through SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so make it your last step. Only a SubagentHandback call reaches your caller as your result; plain text you write at the end is not delivered.\n</system-reminder>'
/** A cobrança do motor quando o passo termina sem a entrega (linhas 13, 15 e 17 da transcrição). */
const NUDGE = '[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}) now; the call ends your run.'
const RESTARTED = '[astra] A ponte do Codex reiniciou no meio deste turno, e o que ele pediu ficou sem continuação. Peça de novo.'
const NOTHING = '[astra] Não há pedido novo para o Codex neste passo.'
const OK = [{ kind: 'text', delta: 'ok' }, { kind: 'done', status: 'completed' }]

type Api = { role: 'user' | 'assistant'; content: { type: string; text?: string }[] }
type Posted = { path: string; body: Record<string, unknown> }
type Given = { agentId?: string; api?: readonly Api[]; batches: readonly (readonly object[])[] }

const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const said = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const user = (...texts: string[]): Api => ({ role: 'user', content: texts.map(text => ({ type: 'text', text })) })
const assistant = (text: string): Api => ({ role: 'assistant', content: [{ type: 'text', text }] })
const answer = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } })

function world(on: On, given: Given) {
  mock.clock(on)
  mock.session(on)
  const posted: Posted[] = []
  const state = { rows: [ask(PROMPT)] as readonly SessionMessage[], api: given.api ?? [user(PROMPT)], served: 0, seq: 0, ensured: new Set<string>() }
  const agents = given.agentId === undefined ? [] : [agentInfo({ id: given.agentId, type: 'astra:sol', description: 'prova', status: 'running' })]
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/synthetic' }))
  on('session.model', () => ({ value: 'gpt-6.2-sol' }))
  on('tool.list', () => ({ value: [] }))
  on('session.messages', (_$, e) => ({ value: e.as === 'api' ? [...state.api] : [...state.rows] }))
  on('agent.list', () => ({ value: agents }))
  on('fs.read', (_$, e) => ({ value: e.path.replaceAll('\\', '/').endsWith('schemas/claude-tools.json') ? JSON.stringify({ tools: [] }) : '' }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'READY /run/synthetic/b-ep1.sock ep1 SEGREDO\n' }
    await held
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const path = e.url.replace('http://bridge', '')
    if (path.startsWith('/events')) {
      // Passado o último lote, a ponte falsa não tem mais turno: o mod que chamasse o Codex a mais falharia aqui.
      const batch = given.batches[state.served]
      if (batch === undefined) throw new Error('o passo leu um turno do Codex que o teste não abriu')
      state.served += 1
      const events = batch.map(event => ({ ...event, seq: ++state.seq }))
      return answer(200, { events, next: state.seq })
    }
    const body = JSON.parse(bodyText(e.init?.body)) as Record<string, unknown>
    posted.push({ path, body })
    if (path === '/threads/ensure') {
      const isNew = !state.ensured.has(String(body.key))
      state.ensured = new Set([...state.ensured, String(body.key)])
      return answer(200, { threadId: 'thr-1', isNew })
    }
    if (path === '/turns') return answer(200, { turnId: `cx-${posted.filter(entry => entry.path === '/turns').length}`, seq: state.seq })
    return answer(200, {})
  })
  return { posted, release, state }
}

async function run(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>): Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult }> {
  const chunks: TurnStepChunk[] = []
  for (;;) {
    const item = await stream.next()
    if (item.done) return { chunks, result: item.value }
    chunks.push(item.value)
  }
}

async function opened($: Engine): Promise<void> {
  await $.session.start({ cwd: '/synthetic', surface: null, isInteractive: false })
}

const stepOf = (agentId: string | undefined, index: number) => ({
  turnId: 'gpt-turn',
  index,
  model: 'gpt-6.2-sol',
  effort: 'high' as const,
  messageCount: index + 1,
  ...(agentId === undefined ? {} : { agentId }),
})
const turns = (posted: readonly Posted[]): Posted[] => posted.filter(entry => entry.path === '/turns')
const HANDED_OK = [{ name: 'SubagentHandback', input: { message: 'ok' } }]

test('entrega: no subagente com o lembrete do motor, a resposta do Codex sai pelo SubagentHandback com o texto inteiro', async ($, on) => {
  const agentId = 'agent-entrega'
  const { posted, release } = world(on, { agentId, api: [user(PROMPT, HANDBACK_REMINDER)], batches: [OK] })
  await opened($)
  const { chunks, result } = await run($.turn.step(stepOf(agentId, 0)))
  release()
  expect(result.stopReason).toBe('tool_use')
  expect(result.answer).toBe('ok')
  expect(result.toolUses).toEqual(HANDED_OK)
  expect(chunks.filter(chunk => chunk.kind !== 'stop')).toEqual([
    { kind: 'text', index: 0, text: 'ok' },
    { kind: 'tool', index: 1, id: 'toolu_astra_gptturn_0_0', name: 'SubagentHandback' },
    { kind: 'input', index: 1, json: JSON.stringify({ message: 'ok' }) },
  ])
  // Um turno só do Codex, e o pedido de entrega não chega a ele: quem entrega é o mod.
  expect(turns(posted)).toHaveLength(1)
  expect(String(turns(posted)[0]?.body.text)).not.toContain('SubagentHandback')
  expect(String(turns(posted)[0]?.body.text)).toContain(PROMPT)
})

test('entrega: a resposta longa, em vários pedaços, vai inteira na message', async ($, on) => {
  const agentId = 'agent-longa'
  const parts = ['Relatório.\n\n', '1. Feito o conserto.\n', '2. Testes passando.']
  const { release } = world(on, { agentId, api: [user(PROMPT), user(HANDBACK_REMINDER)], batches: [[...parts.map(delta => ({ kind: 'text', delta })), { kind: 'done', status: 'completed' }]] })
  await opened($)
  const { result } = await run($.turn.step(stepOf(agentId, 0)))
  release()
  expect(result.toolUses).toEqual([{ name: 'SubagentHandback', input: { message: parts.join('') } }])
})

test('entrega: o turno do Codex que falha também chega a quem chamou, pela ferramenta', async ($, on) => {
  const agentId = 'agent-falha'
  const { release } = world(on, { agentId, api: [user(PROMPT, HANDBACK_REMINDER)], batches: [[{ kind: 'done', status: 'failed', error: 'limite de uso' }]] })
  await opened($)
  const { chunks, result } = await run($.turn.step(stepOf(agentId, 0)))
  release()
  const failure = '[astra] O turno do Codex falhou: limite de uso'
  expect(result.toolUses).toEqual([{ name: 'SubagentHandback', input: { message: failure } }])
  expect(chunks.filter(chunk => chunk.kind === 'tool')).toEqual([{ kind: 'tool', index: 1, id: 'toolu_astra_gptturn_0_0', name: 'SubagentHandback' }])
})

test('sem a ferramenta (subagente sem o lembrete, outro modo de permissão): a resposta sai em texto, como antes', async ($, on) => {
  const agentId = 'agent-texto'
  const { release } = world(on, { agentId, batches: [OK] })
  await opened($)
  const { result } = await run($.turn.step(stepOf(agentId, 0)))
  release()
  expect(result).toMatchObject({ stopReason: 'end_turn', answer: 'ok', toolUses: [] })
})

test('conversa principal: a resposta sai em texto, mesmo com o lembrete no transcript', async ($, on) => {
  const { posted, release } = world(on, { api: [user(PROMPT, HANDBACK_REMINDER)], batches: [OK] })
  await opened($)
  const { result } = await run($.turn.step(stepOf(undefined, 0)))
  release()
  expect(result).toMatchObject({ stopReason: 'end_turn', answer: 'ok', toolUses: [] })
  expect(turns(posted)[0]?.body.key).toBe(MAIN)
})

test('transcrição de 18/11: a cobrança depois do "ok" entrega o "ok" pelo SubagentHandback, sem chamar o Codex outra vez nem dizer que a ponte reiniciou', async ($, on) => {
  // O lembrete não está no formato da API (por exemplo, saiu numa compactação): o passo 0 responde em texto, como na prova.
  const agentId = 'agent-transcricao'
  const { posted, release, state } = world(on, { agentId, batches: [OK] })
  await opened($)
  const first = await run($.turn.step(stepOf(agentId, 0)))
  expect(first.result).toMatchObject({ stopReason: 'end_turn', answer: 'ok' })
  // Linhas 12 e 13: o "ok" e a cobrança, que é isMeta e as linhas de `$.session.messages()` não mostram.
  state.rows = [...state.rows, said('ok')]
  state.api = [...state.api, assistant('ok'), user(NUDGE)]
  const second = await run($.turn.step(stepOf(agentId, 1)))
  // Linhas 14 e 15 (antes, RESTARTED): a entrega, e a cobrança seguinte, se vier, entrega de novo do mesmo jeito.
  expect(second.result).toMatchObject({ stopReason: 'tool_use', answer: '', toolUses: HANDED_OK })
  expect(second.chunks.filter(chunk => chunk.kind === 'tool')).toEqual([{ kind: 'tool', index: 0, id: 'toolu_astra_gptturn_1_0', name: 'SubagentHandback' }])
  state.rows = [...state.rows, { role: 'assistant', text: '', toolUses: [{ tool: 'SubagentHandback', tool_use_id: 'toolu_astra_gptturn_1_0', input: { message: 'ok' } }] }, ask(NUDGE)]
  state.api = [...state.api, assistant(''), user(NUDGE)]
  const third = await run($.turn.step(stepOf(agentId, 2)))
  release()
  expect(third.result).toMatchObject({ stopReason: 'tool_use', toolUses: HANDED_OK })
  for (const { chunks } of [second, third]) expect(chunks.some(chunk => chunk.kind === 'text' && chunk.text === RESTARTED)).toBe(false)
  // Um turno só do Codex nos três passos.
  expect(turns(posted)).toHaveLength(1)
})

test('continuação com mensagem nova (um hook de parada devolve o turno): abre um turno novo do Codex na mesma thread com ela', async ($, on) => {
  const agentId = 'agent-hook'
  const feedback = 'Stop hook feedback:\nFaltou rodar os testes antes de responder.'
  const { posted, release, state } = world(on, { agentId, batches: [OK, [{ kind: 'text', delta: 'Rodei os testes: passam.' }, { kind: 'done', status: 'completed' }]] })
  await opened($)
  await run($.turn.step(stepOf(agentId, 0)))
  state.rows = [...state.rows, said('ok')]
  state.api = [...state.api, assistant('ok'), user(feedback)]
  const { result } = await run($.turn.step(stepOf(agentId, 1)))
  release()
  expect(result).toMatchObject({ stopReason: 'end_turn', answer: 'Rodei os testes: passam.', toolUses: [] })
  expect(posted.map(entry => entry.path)).toEqual(['/threads/ensure', '/turns', '/threads/ensure', '/turns'])
  expect(turns(posted)[1]?.body).toMatchObject({ key: agentId, owner: 'gpt-turn' })
  expect(String(turns(posted)[1]?.body.text)).toContain(feedback)
  expect(String(turns(posted)[1]?.body.text)).not.toContain(PROMPT)
})

test('continuação com a mensagem de um hook e a cobrança juntas: o Codex recebe só a mensagem, e a resposta nova sai pela ferramenta', async ($, on) => {
  const agentId = 'agent-hook-entrega'
  const feedback = 'Stop hook feedback:\nInclua o caminho do arquivo.'
  const { posted, release, state } = world(on, { agentId, batches: [OK, [{ kind: 'text', delta: 'ok, em hooks/native.ts' }, { kind: 'done', status: 'completed' }]] })
  await opened($)
  await run($.turn.step(stepOf(agentId, 0)))
  state.rows = [...state.rows, said('ok')]
  state.api = [...state.api, assistant('ok'), user(feedback, NUDGE)]
  const { result } = await run($.turn.step(stepOf(agentId, 1)))
  release()
  expect(result.toolUses).toEqual([{ name: 'SubagentHandback', input: { message: 'ok, em hooks/native.ts' } }])
  expect(String(turns(posted)[1]?.body.text)).toContain(feedback)
  expect(String(turns(posted)[1]?.body.text)).not.toContain('SubagentHandback')
})

test('continuação sem nada novo e sem resposta pronta: o aviso de que não há pedido, nunca o de que a ponte reiniciou', async ($, on) => {
  const agentId = 'agent-vazio'
  const { posted, release, state } = world(on, { agentId, batches: [] })
  await opened($)
  state.rows = [ask(PROMPT), { role: 'assistant', text: '', toolUses: [{ tool: 'Agent', tool_use_id: 'x', input: {} }] }]
  state.api = [user(PROMPT), assistant('')]
  const { result } = await run($.turn.step(stepOf(agentId, 1)))
  release()
  expect(result).toMatchObject({ stopReason: 'end_turn', answer: NOTHING })
  expect(turns(posted)).toHaveLength(0)
})

test('conversa principal: continuação sem nada novo repete a última resposta em texto, sem chamar o Codex', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [OK] })
  await opened($)
  await run($.turn.step(stepOf(undefined, 0)))
  state.rows = [...state.rows, said('ok')]
  state.api = [...state.api, assistant('ok')]
  const { result } = await run($.turn.step(stepOf(undefined, 1)))
  release()
  expect(result).toMatchObject({ stopReason: 'end_turn', answer: 'ok', toolUses: [] })
  expect(turns(posted)).toHaveLength(1)
})

test('o pedido de entrega se reconhece só no texto do motor: o pedido da pessoa que cita a chamada fica', () => {
  const quoted = 'Explique o que faz SubagentHandback({message: x}) no Claude Code.'
  expect(partsOf(quoted)).toEqual([{ text: quoted, isDemand: false }])
  expect(partsOf(`${PROMPT}\n${HANDBACK_REMINDER}`)).toEqual([
    { text: PROMPT, isDemand: false },
    { text: HANDBACK_REMINDER.replace(/<\/?system-reminder>/g, '').trim(), isDemand: true },
  ])
  expect(partsOf(NUDGE)).toEqual([{ text: NUDGE, isDemand: true }])
  const rows = [ask(`${PROMPT}\n${HANDBACK_REMINDER}`), said('ok'), ask(NUDGE), ask(quoted)]
  expect(withoutDemands(rows)).toEqual([ask(PROMPT), said('ok'), ask(quoted)])
})
