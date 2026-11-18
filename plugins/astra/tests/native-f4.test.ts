import type { AgentInfo, On, SessionAppendInput, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { lateText } from '../hooks/native-news'
import { tailOf } from '../hooks/native-session'
import { COMPACT_MARK } from '../hooks/request'
import { agentInfo, bodyText } from './fixtures/agent-info'

const SESSION = 'synthetic-session'
const MAIN = `main:${SESSION}`
const STEP = { turnId: 'gpt-turn', index: 0, model: 'gpt-6.1-sol', effort: 'low' as const, messageCount: 1 }
const MEMORY = 'WebFetch'
const CODEX_MEMORY = 'WebFetch'
const OBJECT = { type: 'object', properties: { consulta: { type: 'string' } } }
const CATALOG = JSON.stringify({ tools: [{ name: MEMORY, inputSchema: OBJECT }, { name: 'AskUserQuestion', inputSchema: OBJECT }] })
const ID = 'toolu_astra_gptturn_0_0'
const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const asked = (tool: string): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool, tool_use_id: ID, input: { consulta: 'astra' } }] })
const result = (text: string): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: ID, text, isError: false }] })

type Posted = { path: string; body: Record<string, unknown> }
/** `status`: o status que a ponte falsa dá a cada rota (o padrão é 200). */
type Given = { batches: readonly (readonly object[])[]; rows?: readonly SessionMessage[]; status?: Readonly<Record<string, number>>; model?: string; agents?: readonly AgentInfo[] }

const answer = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } })

// Só dados sintéticos, como em native-f1.test.ts: a ponte é o `process.spawn` que diz READY, e o socket é o
// `http.fetch`, que serve os lotes de eventos em ordem e responde cada rota com o status pedido.
function world(on: On, given: Given) {
  mock.clock(on)
  const session = mock.session(on)
  const posted: Posted[] = []
  const polls: string[] = []
  const state = { rows: given.rows ?? [ask('Busque na memória por astra')], served: 0, seq: 0, ensured: new Set<string>(), status: given.status ?? {}, agents: given.agents ?? [] }
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/synthetic' }))
  on('session.model', () => ({ value: given.model ?? 'gpt-6.1-sol' }))
  on('tool.list', () => ({ value: [{ name: MEMORY, description: 'Busca.', mcp: false }, { name: 'AskUserQuestion', description: 'Pergunta.', mcp: false }] }))
  on('session.messages', (_$, e) => ({ value: e.as === 'api' ? [] : [...state.rows] }))
  on('agent.list', () => ({ value: [...state.agents] }))
  on('fs.read', (_$, e) => ({ value: e.path.replaceAll('\\', '/').endsWith('schemas/claude-tools.json') ? CATALOG : e.path.replaceAll('\\', '/').endsWith('/proc/self/cmdline') ? 'claude\0' : '' }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'READY /run/synthetic/b-ep1.sock ep1 SEGREDO\n' }
    await held
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const path = e.url.replace('http://bridge', '')
    if (path.startsWith('/events')) {
      polls.push(path)
      const events = (given.batches[state.served] ?? []).map(event => ({ ...event, seq: ++state.seq }))
      state.served += 1
      return answer(200, { events, next: state.seq })
    }
    const body = JSON.parse(bodyText(e.init?.body)) as Record<string, unknown>
    posted.push({ path, body })
    const status = state.status[path] ?? 200
    if (status !== 200) return answer(status, { error: `a ponte falsa responde ${status}` })
    if (path === '/threads/ensure') {
      const isNew = !state.ensured.has(String(body.key))
      state.ensured = new Set([...state.ensured, String(body.key)])
      return answer(200, { threadId: 'thr-1', isNew })
    }
    if (path === '/turns') return answer(200, { turnId: 'cx-1', seq: state.seq })
    if (path === '/compact') return answer(200, { isCompacting: true })
    return answer(200, {})
  })
  return { posted, polls, release, state, session }
}

async function step(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>): Promise<TurnStepResult> {
  for (;;) {
    const item = await stream.next()
    if (item.done) return item.value
  }
}

async function opened($: Engine): Promise<void> {
  await $.session.start({ cwd: '/synthetic', surface: null, isInteractive: false })
}

const paths = (posted: readonly Posted[]): string[] => posted.map(entry => entry.path)
const LATE = lateText([{ tool: MEMORY, text: 'Astra em worktree', isError: false }])

/** A entrega do Claude Code na fronteira de uma ferramenta, como o 2.1.310 a fez na sonda de 25/10. */
const delivery = (text: string, agentId?: string): SessionAppendInput => ({
  message: { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text: `<system-reminder id="r1"> ${text} </system-reminder id="r1">` }] },
  door: 'delivery',
  origin: { kind: 'coordinator' },
  uuid: `u-${text.length}`,
  ...(agentId === undefined ? {} : { agentId }),
})

test('resultado tardio com o turno do Codex já fechado: os resultados abrem um turno novo na mesma thread', async ($, on) => {
  const { posted, polls, release, state } = world(on, {
    batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }], [{ kind: 'text', delta: 'Li o resultado.' }, { kind: 'done', status: 'completed' }]],
    status: { '/tool-result': 409, '/steer': 409 },
  })
  await opened($)
  await step($.turn.step(STEP))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  const second = await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/tool-result', '/steer', '/threads/ensure', '/turns'])
  expect(posted[3]?.body).toEqual({ key: MAIN, text: LATE })
  expect(posted.at(-1)?.body).toMatchObject({ key: MAIN, text: LATE })
  expect(LATE).toBe('[astra] Resultados das ferramentas do Claude Code que chegaram depois que o turno anterior foi encerrado:\n\n### WebFetch\nAstra em worktree')
  expect(polls[1]).toContain('after=1')
  expect(second.answer).toBe('Li o resultado.')
})

test('resultado tardio com o turno ainda aberto: vai por /steer, e o passo segue lendo o mesmo turno', async ($, on) => {
  const { posted, polls, release, state } = world(on, {
    batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }], [{ kind: 'text', delta: 'Recebi.' }, { kind: 'done', status: 'completed' }]],
    status: { '/tool-result': 409 },
  })
  await opened($)
  await step($.turn.step(STEP))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  const second = await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/tool-result', '/steer'])
  expect(posted[3]?.body).toEqual({ key: MAIN, text: LATE })
  expect(polls[1]).toContain('after=1')
  expect(second.answer).toBe('Recebi.')
})

test('AskUserQuestion: a ponte passa a chamada ao Claude Code na hora, e o passo sai com o tool_use', async ($, on) => {
  const { posted, release } = world(on, { batches: [[{ kind: 'toolCall', callId: 'call-q', tool: 'AskUserQuestion', args: { consulta: 'qual?' } }]] })
  await opened($)
  const first = await step($.turn.step(STEP))
  release()
  expect(first.toolUses).toEqual([{ name: 'AskUserQuestion', input: { consulta: 'qual?' } }])
  expect(posted.find(entry => entry.path === '/handoff')?.body).toEqual({ key: MAIN, callId: 'call-q' })
})

test('entrega no meio do turno: o recado vai ao Codex por /steer depois dos resultados, sem as tags do lembrete', async ($, on) => {
  const { posted, release, state } = world(on, {
    batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }], [{ kind: 'text', delta: 'Visto.' }, { kind: 'done', status: 'completed' }]],
  })
  await opened($)
  await $.session.append(delivery('antes do 1º passo GPT'))
  await step($.turn.step(STEP))
  await $.session.append(delivery('recado do coordenador'))
  await $.session.append(delivery('de um subagente Claude', 'agent-claude'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(posted.find(entry => entry.path === '/turns')?.body.text).toBe('Busque na memória por astra')
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/tool-result', '/steer'])
  expect(posted[3]?.body).toEqual({ key: MAIN, text: 'recado do coordenador' })
})

test('o recado que chega com o turno já fechado vai no pedido do turno seguinte', async ($, on) => {
  const { posted, release, state } = world(on, {
    batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }], [{ kind: 'done', status: 'completed' }], [{ kind: 'done', status: 'completed' }]],
    status: { '/tool-result': 409, '/steer': 409 },
  })
  await opened($)
  await step($.turn.step(STEP))
  await $.session.append(delivery('recado tardio'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(posted.at(-1)?.body.text).toBe(`${LATE}\n\nrecado tardio`)
})

test('o turno fecha entre os resultados e o recado: o recado volta à caixa e vai no pedido seguinte', async ($, on) => {
  const { posted, release, state } = world(on, {
    batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }], [{ kind: 'text', delta: 'Fim.' }, { kind: 'done', status: 'completed' }], [{ kind: 'done', status: 'completed' }]],
    status: { '/steer': 409 },
  })
  await opened($)
  await step($.turn.step(STEP))
  await $.session.append(delivery('recado'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  const second = await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  state.rows = [...state.rows, { role: 'assistant', text: 'Fim.', toolUses: [] }, ask('Novo pedido')]
  await step($.turn.step({ ...STEP, turnId: 'turno-2', messageCount: 5 }))
  release()
  expect(second.answer).toBe('Fim.')
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/tool-result', '/steer', '/threads/ensure', '/turns'])
  expect(posted.at(-1)?.body.text).toBe('Novo pedido\n\nrecado')
})

test('passo que falha depois de tirar a caixa: o recado volta e vai no pedido do turno seguinte', async ($, on) => {
  const { posted, release, state } = world(on, {
    batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }], [{ kind: 'done', status: 'completed' }]],
    status: { '/tool-result': 500 },
  })
  await opened($)
  await step($.turn.step(STEP))
  await $.session.append(delivery('recado'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  const failed = await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  state.status = {}
  state.rows = [...state.rows, { role: 'assistant', text: failed.answer, toolUses: [] }, ask('Novo pedido')]
  await step($.turn.step({ ...STEP, turnId: 'turno-2', messageCount: 5 }))
  release()
  expect(failed.answer).toContain('[astra] O Codex não conseguiu responder a este passo')
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/tool-result', '/threads/ensure', '/turns'])
  expect(posted.at(-1)?.body.text).toBe('Novo pedido\n\nrecado')
})

test('passo recusado: o recado ao subagente volta à caixa e vai no 1º turno que abre', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[{ kind: 'done', status: 'completed' }]] })
  await opened($)
  const refused = await step($.turn.step({ ...STEP, agentId: 'agent-x' }))
  await $.session.append(delivery('recado ao subagente', 'agent-x'))
  await step($.turn.step({ ...STEP, agentId: 'agent-x', turnId: 'turno-2' }))
  state.agents = [agentInfo({ id: 'agent-x', type: 'general-purpose', description: 'teste', status: 'running' })]
  await step($.turn.step({ ...STEP, agentId: 'agent-x', turnId: 'turno-3' }))
  release()
  expect(refused.answer).toContain('não está na lista da sessão')
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns'])
  expect(posted[1]?.body).toMatchObject({ key: 'agent-x', text: 'Busque na memória por astra\n\nrecado ao subagente' })
})

test('o marcador da compactação do mod não vai ao Codex como pedido', async ($, on) => {
  const rows = [{ ...ask(`${COMPACT_MARK} 4 mensagens anteriores saíram do transcript do Claude Code.`) }, ask('Pedido atual')]
  const { posted, release } = world(on, { batches: [[{ kind: 'done', status: 'completed' }]], rows })
  await opened($)
  await step($.turn.step(STEP))
  release()
  expect(posted.find(entry => entry.path === '/turns')?.body.text).toBe('Pedido atual')
})

test('sem turno à espera no meio do turno do Claude Code (o mod recarregou): os resultados saem do transcript', async ($, on) => {
  const rows = [ask('Busque na memória por astra'), asked(MEMORY), result('Astra em worktree')]
  const { posted, release } = world(on, { batches: [[{ kind: 'text', delta: 'Retomei.' }, { kind: 'done', status: 'completed' }]], rows })
  await opened($)
  const resumed = await step($.turn.step({ ...STEP, turnId: 'outro-turno', index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns'])
  expect(posted[0]?.body).toMatchObject({ key: MAIN, session: SESSION })
  expect(String(posted[1]?.body.text)).toContain(LATE)
  expect(resumed.answer).toBe('Retomei.')
})

test('thread nova num loop que já tem conversa: o 1º turno leva o histórico; a retomada, só o pedido novo', async ($, on) => {
  const rows = [ask('Primeiro pedido'), { role: 'assistant' as const, text: 'Primeira resposta.', toolUses: [] }, ask('Segundo pedido')]
  const { posted, release } = world(on, { batches: [[{ kind: 'done', status: 'completed' }], [{ kind: 'done', status: 'completed' }]], rows })
  await opened($)
  await step($.turn.step(STEP))
  await step($.turn.step({ ...STEP, turnId: 'turno-2' }))
  release()
  const turns = posted.filter(entry => entry.path === '/turns').map(entry => entry.body.text)
  expect(turns[0]).toBe('A conversa anterior do Codex para este agente não está mais disponível. Este é o histórico até aqui; responda ao último pedido.\n\n[pedido]\nPrimeiro pedido\n\n[sua resposta]\nPrimeira resposta.\n\n[pedido]\nSegundo pedido')
  expect(turns[1]).toBe('Segundo pedido')
})

test('compactação de um loop GPT: o mod responde, sem resumo do motor; precompute pula; num modelo Claude, o motor', async ($, on) => {
  world(on, { batches: [] })
  const reached: string[] = []
  on('session.compact', (_$, e) => {
    reached.push(e.trigger)
    return { skip: 'do motor' }
  })
  const messages: SessionMessage[] = [{ ...ask('velho'), handle: 'h1' }, { role: 'assistant', text: 'resposta velha', toolUses: [], handle: 'h2' }, { ...ask('pedido atual'), handle: 'h3' }]
  const auto = await $.session.compact({ trigger: 'auto', messages })
  expect(auto.messages?.map(row => row.handle ?? row.text)).toEqual([
    '[astra] Compactado: 2 mensagens anteriores saíram do transcript do Claude Code; a conversa inteira segue na thread do Codex, e a thread se compacta sozinha perto de 400 mil tokens.',
    'h3',
  ])
  expect(await $.session.compact({ trigger: 'precompute', messages })).toEqual({ skip: 'o loop do Codex não usa resumo prévio' })
  expect(reached).toEqual([])
  // Um subagente que não teve passo GPT é do motor, mesmo com o loop principal no Codex.
  expect(await $.session.compact({ trigger: 'auto', agentId: 'agent-claude', messages })).toEqual({ skip: 'do motor' })
  expect(reached).toEqual(['auto'])
})

test('compactação num modelo Claude segue para o motor', async ($, on) => {
  world(on, { batches: [], model: 'claude-opus-5-5' })
  on('session.compact', () => ({ skip: 'do motor' }))
  expect(await $.session.compact({ trigger: 'auto', messages: [ask('oi')] })).toEqual({ skip: 'do motor' })
})

test('/compact com a ponte de pé: o Codex compacta a thread do loop agora; o /clear solta as threads da sessão', async ($, on) => {
  const { posted, release } = world(on, { batches: [[{ kind: 'done', status: 'completed' }]] })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await opened($)
  await step($.turn.step(STEP))
  const manual = await $.session.compact({ trigger: 'manual', messages: [ask('pedido')] })
  expect(manual.messages?.[0]?.text).toContain('e o Codex compacta a thread agora.')
  expect(posted.find(entry => entry.path === '/compact')?.body).toEqual({ key: MAIN })
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  release()
  expect(posted.at(-1)).toEqual({ path: '/forget', body: { session: SESSION } })
})

test('/clear com uma ferramenta pendente: o loop que volta (o /resume) abre turno sem interromper a thread solta', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }], [{ kind: 'done', status: 'completed' }]] })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await opened($)
  await step($.turn.step(STEP))
  await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  state.rows = [ask('Outro pedido')]
  await step($.turn.step({ ...STEP, turnId: 'turno-2' }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/forget', '/threads/ensure', '/turns'])
})

const ENDED = { answer: '', durationMs: 1, turnId: 'gpt-turn' }

test('Esc no turno GPT: o fim do turno fecha o turno do Codex que ele abriu, pelo dono, na hora; o loop Claude, não', async ($, on) => {
  const { posted, release } = world(on, { batches: [[{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }]] })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await opened($)
  await step($.turn.step(STEP))
  expect(posted[1]?.body.owner).toBe('gpt-turn')
  await $.turn.complete({ ...ENDED, reason: 'aborted', isAborted: true, agentId: 'agent-claude' })
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns'])
  expect(await $.turn.complete({ ...ENDED, reason: 'aborted', isAborted: true })).toEqual({ text: '' })
  release()
  expect(posted.slice(2)).toEqual([{ path: '/interrupt', body: { key: MAIN, owner: 'gpt-turn' } }])
})

test('o que fica na compactação: do último pedido em texto; grande demais, da última resposta em diante', () => {
  const big = 'x'.repeat(210_000)
  const rows: SessionMessage[] = [ask('a'), { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 't1', input: {} }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: big, isError: false }] }, { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 't2', input: {} }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't2', text: 'ok', isError: false }] }]
  expect(tailOf(rows).length).toBe(2)
  expect(tailOf(rows.slice(0, 1))).toEqual([ask('a')])
  expect(tailOf([ask('a'), { role: 'assistant', text: 'b', toolUses: [] }, ask('c')])).toEqual([ask('c')])
})
