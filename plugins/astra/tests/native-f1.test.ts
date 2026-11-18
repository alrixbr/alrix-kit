import type { On, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { type Engine, expect, mock, type MockClock, test } from 'claude-code/testing'
import { agentInfo, bodyText } from './fixtures/agent-info'

const SESSION = 'synthetic-session'
const STEP = { turnId: 'gpt-turn', index: 0, model: 'gpt-6.1-sol', effort: 'low' as const, messageCount: 1 }
const MEMORY = 'WebFetch'
/** O nome que o Codex vê: o App Server recusa o prefixo `mcp__`. */
const CODEX_MEMORY = 'WebFetch'
const CATALOG = JSON.stringify({ tools: [{ name: MEMORY, inputSchema: { type: 'object', properties: { consulta: { type: 'string' } }, required: ['consulta'] } }] })
const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

type Posted = { path: string; body: Record<string, unknown> }
/** `beforePoll` roda antes de cada lote servido: é onde a ponte falsa responde tarde (`clock.sleep`); no lote `failAt`, `/events` responde 500. */
type Given = { batches: readonly (readonly object[])[]; rows?: readonly SessionMessage[]; beforePoll?: (served: number, clock: MockClock) => Promise<void> | undefined; failAt?: number }

const answer = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })

// Só dados sintéticos: nenhuma ponte, nenhum App Server e nenhuma conta de verdade. A ponte é o `process.spawn`, que
// diz READY e fica aberta até o teste soltá-la; o socket é o `http.fetch`, que serve os lotes de eventos em ordem.
// Como a ponte de verdade, o `/turns` depois de um `/interrupt` conta antes o `done` do turno que se interrompia.
function world(on: On, given: Given) {
  const clock = mock.clock(on)
  const posted: Posted[] = []
  const polls: string[] = []
  const spawns: string[][] = []
  const state = { rows: given.rows ?? [ask('Busque na memória por astra')], served: 0, seq: 0, isClosing: false, ensured: new Set<string>() }
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/synthetic' }))
  on('tool.list', () => ({ value: [{ name: MEMORY, description: 'Busca na web.', mcp: false }, { name: 'Bash', description: 'Roda um comando.', mcp: false }] }))
  on('session.messages', (_$, e) => ({ value: e.as === 'api' ? [] : [...state.rows] }))
  on('fs.read', (_$, e) => ({ value: e.path.replaceAll('\\', '/').endsWith('schemas/claude-tools.json') ? CATALOG : e.path.replaceAll('\\', '/').endsWith('/proc/self/cmdline') ? 'claude\0' : '' }))
  on('process.spawn', async function* (_$, e) {
    spawns.push([...e.argv])
    yield { stream: 'stdout' as const, text: 'READY /run/synthetic/b-ep1.sock ep1 SEGREDO\n' }
    await held
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const path = e.url.replace('http://bridge', '')
    if (path.startsWith('/events')) {
      polls.push(path)
      await given.beforePoll?.(state.served, clock)
      if (state.served === given.failAt) return { value: { status: 500, ok: false, headers: {}, text: JSON.stringify({ error: 'o App Server caiu' }) } }
      const events = (given.batches[state.served] ?? []).map(event => ({ ...event, seq: ++state.seq }))
      state.served += 1
      return answer({ events, next: state.seq })
    }
    const body = JSON.parse(bodyText(e.init?.body)) as Record<string, unknown>
    posted.push({ path, body })
    // Como a ponte de verdade: a thread é nova só no 1º ensure do loop.
    if (path === '/threads/ensure') {
      const isNew = !state.ensured.has(String(body.key))
      state.ensured = new Set([...state.ensured, String(body.key)])
      return answer({ threadId: 'thr-1', isNew })
    }
    if (path === '/turns') {
      state.seq += state.isClosing ? 1 : 0
      state.isClosing = false
      return answer({ turnId: 'cx-1', seq: state.seq })
    }
    if (path === '/interrupt') state.isClosing = true
    return answer({ isAnswered: true, isInterrupting: true })
  })
  return { clock, posted, polls, spawns, release, state }
}

async function opened($: Engine): Promise<void> {
  await $.session.start({ cwd: '/synthetic', surface: null, isInteractive: false })
}

async function step(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>) {
  const chunks: TurnStepChunk[] = []
  for (;;) {
    const item = await stream.next()
    if (item.done) return { chunks, result: item.value }
    chunks.push(item.value)
  }
}

/** O motor da Anthropic no fundo da cadeia: se um passo GPT chegar aqui, o teste mostra. */
function apiBottom(on: On): { reached: string[] } {
  const reached: string[] = []
  on('turn.step', async function* (_$, e) {
    reached.push(e.model)
    yield { kind: 'text', index: 0, text: 'do modelo' }
    return { turnId: e.turnId, index: e.index, answer: 'do modelo', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { reached }
}

const textOf = (chunks: readonly TurnStepChunk[], kind: 'text' | 'thinking') => chunks.flatMap(chunk => (chunk.kind === kind ? [chunk.text] : [])).join('')

test('sem o session.start desta carga, o passo GPT responde o erro e nunca vai à API da Anthropic', async ($, on) => {
  const { reached } = apiBottom(on)
  world(on, { batches: [] })
  const { result } = await step($.turn.step(STEP))
  expect(result.answer).toContain('[astra] O Codex não conseguiu responder a este passo')
  expect(result.answer).toContain('session.start')
  expect(reached).toEqual([])
})

test('passo GPT: a ponte nasce do laço do session.start, o comentário vira pensamento e a resposta vira texto', async ($, on) => {
  const { reached } = apiBottom(on)
  const { posted, spawns, release } = world(on, { batches: [[
    { kind: 'thinking', delta: 'Vou olhar o projeto.' },
    { kind: 'item', phase: 'started', item: { type: 'commandExecution', command: 'ls -la' } },
    { kind: 'item', phase: 'completed', item: { type: 'commandExecution', command: 'ls -la', exitCode: 0 } },
    { kind: 'text', delta: 'Pronto.' },
    { kind: 'done', status: 'completed' },
  ]] })
  await opened($)
  expect(spawns).toEqual([])
  const { chunks, result } = await step($.turn.step(STEP))
  release()
  expect(spawns).toHaveLength(1)
  // O Node do PATH, sem shell e sem programa de um sistema só; a porta de entrada confere a versão dele.
  expect(spawns[0]?.slice(0, 2)).toEqual(['node', '--no-warnings'])
  expect(spawns[0]?.slice(3)).toEqual(['--session', SESSION])
  expect(spawns[0]?.[2]?.replaceAll('\\', '/').endsWith('/bridge/start.mjs')).toBe(true)
  expect(textOf(chunks, 'thinking')).toBe('Vou olhar o projeto.\n$ ls -la\n$ ls -la → exit 0\n')
  expect(chunks.filter(chunk => chunk.kind === 'text')).toEqual([{ kind: 'text', index: 1, text: 'Pronto.' }])
  expect(result).toMatchObject({ answer: 'Pronto.', stopReason: 'end_turn', toolUses: [], usage: null })
  const ensure = posted.find(entry => entry.path === '/threads/ensure')?.body
  expect(ensure).toMatchObject({ key: `main:${SESSION}`, cwd: '/synthetic', model: 'gpt-6.1-sol' })
  expect(ensure?.dynamicTools).toEqual([expect.objectContaining({ type: 'namespace', name: 'claude_code', tools: [expect.objectContaining({ type: 'function', name: CODEX_MEMORY, deferLoading: true })] })])
  expect(posted.find(entry => entry.path === '/turns')?.body).toEqual({ key: `main:${SESSION}`, text: 'Busque na memória por astra', model: 'gpt-6.1-sol', effort: 'low', owner: 'gpt-turn' })
  expect(reached).toEqual([])
})

test('ferramenta do Claude Code: sai como tool_use e o resultado volta ao mesmo turno do Codex no passo seguinte', async ($, on) => {
  const { posted, polls, release, state } = world(on, { batches: [
    [{ kind: 'text', delta: 'Vou buscar.' }, { kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }],
    [{ kind: 'text', delta: 'Achei a nota Astra.' }, { kind: 'done', status: 'completed' }],
  ] })
  await opened($)
  const first = await step($.turn.step(STEP))
  const id = `toolu_astra_gptturn_0_0`
  expect(first.chunks.slice(1)).toEqual([
    { kind: 'tool', index: 1, id, name: MEMORY },
    { kind: 'input', index: 1, json: JSON.stringify({ consulta: 'astra' }) },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ])
  expect(first.result.toolUses).toEqual([{ name: MEMORY, input: { consulta: 'astra' } }])
  state.rows = [...state.rows,
    { role: 'assistant', text: 'Vou buscar.', toolUses: [{ tool: MEMORY, tool_use_id: id, input: { consulta: 'astra' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Astra em worktree', isError: false }] }]
  const second = await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(posted.filter(entry => entry.path === '/turns')).toHaveLength(1)
  expect(posted.find(entry => entry.path === '/tool-result')?.body).toEqual({ key: `main:${SESSION}`, callId: 'call-1', text: 'Astra em worktree', isError: false })
  expect(polls[1]).toContain('after=2')
  expect(second.result).toMatchObject({ answer: 'Achei a nota Astra.', stopReason: 'end_turn' })
})

test('ferramenta fora do catálogo: a ponte recebe o erro e o turno segue sem sair do passo', async ($, on) => {
  const { posted, release } = world(on, { batches: [
    [{ kind: 'toolCall', callId: 'call-x', tool: 'Bash', args: { command: 'ls' } }],
    [{ kind: 'text', delta: 'Sem Bash, sigo.' }, { kind: 'done', status: 'completed' }],
  ] })
  await opened($)
  const { result } = await step($.turn.step(STEP))
  release()
  expect(posted.find(entry => entry.path === '/tool-result')?.body).toMatchObject({ callId: 'call-x', isError: true })
  expect(result).toMatchObject({ answer: 'Sem Bash, sigo.', toolUses: [], stopReason: 'end_turn' })
})

test('turno que falha no Codex: o motivo fecha o passo como texto', async ($, on) => {
  const { reached } = apiBottom(on)
  const { release } = world(on, { batches: [[{ kind: 'error', message: 'stream cortado', willRetry: false }, { kind: 'done', status: 'failed', error: 'stream cortado' }]] })
  await opened($)
  const { chunks, result } = await step($.turn.step(STEP))
  release()
  expect(textOf(chunks, 'thinking')).toBe('! stream cortado\n')
  expect(result.answer).toBe('[astra] O turno do Codex falhou: stream cortado')
  expect(reached).toEqual([])
})

test('a ponte falha depois do 1º pedaço: o motivo fecha o passo num bloco novo, sem ir à API', async ($, on) => {
  const { reached } = apiBottom(on)
  const { posted, release } = world(on, { batches: [[{ kind: 'thinking', delta: 'Olhando.' }]], failAt: 1 })
  await opened($)
  const { chunks, result } = await step($.turn.step(STEP))
  release()
  expect(chunks[0]).toEqual({ kind: 'thinking', index: 0, text: 'Olhando.' })
  expect(chunks.slice(1)).toEqual([
    { kind: 'text', index: 1, text: '[astra] O turno do Codex falhou: a ponte parou de responder no meio do turno (a ponte respondeu 500: o App Server caiu)' },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ])
  expect(result).toMatchObject({ stopReason: 'end_turn', toolUses: [] })
  expect(posted.at(-1)?.path).toBe('/interrupt')
  expect(reached).toEqual([])
})

test('um minuto sem evento: o passo mostra o sinal de vida e continua lendo', async ($, on) => {
  const { clock, release } = world(on, {
    batches: [[], [{ kind: 'text', delta: 'Terminei.' }, { kind: 'done', status: 'completed' }]],
    beforePoll: (served, late) => (served === 0 ? late.sleep(61_000) : undefined),
  })
  await opened($)
  const running = step($.turn.step(STEP))
  await clock.advance(61_000)
  const { chunks, result } = await running
  release()
  expect(textOf(chunks, 'thinking')).toContain('[astra] Codex trabalhando há 1 min; sem evento novo há 1 min')
  expect(result.answer).toBe('Terminei.')
})

test('turno novo com ferramenta pendente do anterior (Esc ou "No" no diálogo): a ponte interrompe antes de abrir o novo', async ($, on) => {
  const { posted, polls, release, state } = world(on, { batches: [
    [{ kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'a' } }],
    [{ kind: 'text', delta: 'Novo pedido feito.' }, { kind: 'done', status: 'completed' }],
  ] })
  await opened($)
  await step($.turn.step(STEP))
  const id = 'toolu_astra_gptturn_0_0'
  state.rows = [...state.rows,
    { role: 'assistant', text: '', toolUses: [{ tool: MEMORY, tool_use_id: id, input: { consulta: 'a' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'Interrupted by user', isError: true }] },
    ask('Esquece, faça outra coisa')]
  const { result } = await step($.turn.step({ ...STEP, turnId: 'next-turn', messageCount: 3 }))
  release()
  expect(posted.map(entry => entry.path)).toEqual(['/threads/ensure', '/turns', '/interrupt', '/threads/ensure', '/turns'])
  expect(posted.at(-1)?.body).toMatchObject({ text: 'Esquece, faça outra coisa' })
  // O cursor do turno novo é o do `/turns` (2, depois do `done` do turno interrompido), e não o do fim do 1º lote.
  expect(polls[1]).toContain('after=2')
  expect(result.answer).toBe('Novo pedido feito.')
})

test('passo de um modelo Claude segue para o modelo, sem ponte', async ($, on) => {
  const { reached } = apiBottom(on)
  const { spawns } = world(on, { batches: [] })
  await opened($)
  const { result } = await step($.turn.step({ ...STEP, model: 'claude-opus-5-5' }))
  expect(result.answer).toBe('do modelo')
  expect(reached).toEqual(['claude-opus-5-5'])
  expect(spawns).toEqual([])
})
