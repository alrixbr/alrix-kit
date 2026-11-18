import type { AgentInfo, On, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { agentInfo, bodyText } from './fixtures/agent-info'

// O contrato com outros plugins (README, "Para quem escreve outro plugin") e o que a pessoa lê quando falta algo na
// máquina. Só dados sintéticos: a ponte é o `process.spawn`, e o canal é o `http.fetch`, que fecha o turno no 1º lote.
const SESSION = 'synthetic-session'
const STEP = { turnId: 'gpt-turn', index: 0, model: 'gpt-6.2-astra', effort: 'high' as const, messageCount: 1 }
const OBJECT = { type: 'object', properties: { x: { type: 'string' } } }
const SCHEMAS = JSON.stringify({ tools: ['Agent', 'SendMessage', 'ListAgents', 'WebFetch'].map(name => ({ name, inputSchema: OBJECT })) })
const LISTED = ['Agent', 'SendMessage', 'ListAgents', 'WebFetch', 'Read', 'Edit', 'Write', 'PowerShell'].map(name => ({ name, description: name, mcp: false }))
const FILES: Readonly<Record<string, string>> = { 'schemas/claude-tools.json': SCHEMAS, 'roles/bridge.md': 'PONTE\n', 'roles/native.md': 'BASE\n', 'roles/native-builder.md': 'CONSTRUTOR\n' }
const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const answer = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } })
const agent = (id: string, type: string): AgentInfo => agentInfo({ id, type, description: 'teste', status: 'running' })

type Fetched = { url: string; path: string; body: Record<string, unknown>; headers: Record<string, string>; socketPath?: string }
type Spawned = { stdout?: string; stderr?: string; throws?: string }
type Given = { rows?: readonly SessionMessage[]; agents?: readonly AgentInfo[]; spawn?: Spawned; ensureStatus?: { status: number; error: string } }

function world(on: On, given: Given) {
  mock.clock(on)
  const fetched: Fetched[] = []
  const registered: string[] = []
  const commands: string[] = []
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/synthetic' }))
  on('session.messages', (_$, e) => ({ value: e.as === 'api' ? [] : [...(given.rows ?? [ask('Faça')])] }))
  on('tool.list', () => ({ value: LISTED }))
  on('agent.list', () => ({ value: [...(given.agents ?? [])] }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_$, e) => {
    const path = e.path.replaceAll('\\', '/')
    return { value: FILES[Object.keys(FILES).find(name => path.endsWith(`/${name}`)) ?? ''] ?? '' }
  })
  // O motor no fundo da cadeia: dá ao tipo o nome completo, com o plugin que o registrou.
  on('agent.register', (_$, e, next) => {
    registered.push(`${next.origin.plugin}:${e.name}`)
    return { value: { agent: `${next.origin.plugin}:${e.name}` } }
  })
  on('process.spawn', async function* () {
    const spawn = given.spawn ?? { stdout: 'READY /run/synthetic/b.sock ep1 SEGREDO-DA-SESSAO\n' }
    if (spawn.throws !== undefined) throw new Error(spawn.throws)
    if (spawn.stderr !== undefined) yield { stream: 'stderr' as const, text: spawn.stderr }
    if (spawn.stdout !== undefined) {
      yield { stream: 'stdout' as const, text: spawn.stdout }
      await held
    }
    return { value: { code: spawn.stdout === undefined ? 1 : 0, signal: null } }
  })
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const path = `${url.pathname}${url.search}`
    if (path.startsWith('/events')) return answer(200, { events: [{ kind: 'text', delta: 'Feito.', seq: 1 }, { kind: 'done', status: 'completed', seq: 2 }], next: 2 })
    const headers = { ...(e.init?.headers ?? {}) } as Record<string, string>
    fetched.push({ url: e.url, path, body: JSON.parse(bodyText(e.init?.body)) as Record<string, unknown>, headers, socketPath: e.init?.socketPath })
    if (path === '/threads/ensure' && given.ensureStatus !== undefined) return answer(given.ensureStatus.status, { error: given.ensureStatus.error })
    if (path === '/threads/ensure') return answer(200, { threadId: 'thr-1', isNew: true })
    return answer(200, { turnId: 'cx-1', seq: 0 })
  })
  const ensures = (): Record<string, unknown>[] => fetched.filter(entry => entry.path === '/threads/ensure').map(entry => entry.body)
  return { fetched, ensures, registered, commands, release }
}

async function run($: Engine, agentId: string | undefined, model = STEP.model): Promise<TurnStepResult> {
  const stream: AsyncGenerator<TurnStepChunk, TurnStepResult> = $.turn.step({ ...STEP, model, ...(agentId === undefined ? {} : { agentId }) })
  for (;;) {
    const item = await stream.next()
    if (item.done) return item.value
  }
}

const opened = ($: Engine) => $.session.start({ cwd: '/synthetic', surface: null, isInteractive: false })

/**
 * Outro plugin, como o alrix-equipe: registra os tipos dele no `session.start`, cada um com o prompt, o modelo do Codex
 * e as ferramentas. Escrito inteiro aqui, sem nada do arquivo de teste (o motor o carrega como uma pasta de plugin).
 */
const OUTRO = {
  name: 'outro',
  register(on: On) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      const types = [
        { name: 'pesquisador', prompt: 'Você é o pesquisador.\nResponda curto.', tools: ['WebFetch', 'SendMessage'] },
        { name: 'leitor', prompt: 'P', tools: ['WebFetch', 'Read', 'Grep'] },
        { name: 'editor', prompt: 'P', tools: ['Read', 'Edit'] },
        { name: 'escritor', prompt: 'P', tools: ['Write'] },
        { name: 'livre', prompt: 'P' },
        { name: 'tirados', prompt: 'P', disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] },
        { name: 'misto', prompt: 'P', tools: ['Edit', 'Read'], disallowedTools: ['Edit'] },
        { name: 'catalogo', prompt: 'P', tools: ['SendMessage', 'Read'] },
      ]
      for (const type of types) await $.agent.register({ description: type.name, model: 'gpt-6.2-astra', effort: 'high', ...type })
      return started
    })
  },
}
const WITH_OUTRO = { plugins: [OUTRO] }

test('(a) e (b): o passo gpt-* de um tipo de outro plugin vai ao Codex, com o prompt do tipo depois do papel da ponte', WITH_OUTRO, async ($, on) => {
  const { ensures, registered, release } = world(on, { agents: [agent('a1', 'outro:pesquisador')] })
  await opened($)
  expect(registered).toContain('outro:pesquisador')
  const result = await run($, 'a1')
  release()
  expect(result.answer).toBe('Feito.')
  expect(ensures()).toEqual([expect.objectContaining({ key: 'a1', model: 'gpt-6.2-astra', developerInstructions: 'PONTE\n\nVocê é o pesquisador.\nResponda curto.' })])
})

const SANDBOXES = [
  ['sem Edit nem Write: read-only', 'leitor', 'read-only'],
  ['com Edit: workspace-write', 'editor', 'workspace-write'],
  ['com Write: workspace-write', 'escritor', 'workspace-write'],
  ['sem lista de ferramentas: workspace-write', 'livre', 'workspace-write'],
  ['sem lista, mas com Edit, Write, MultiEdit e NotebookEdit tirados: read-only', 'tirados', 'read-only'],
  ['com Edit na lista e também nos tirados: read-only', 'misto', 'read-only'],
] as const

for (const [label, name, sandbox] of SANDBOXES) {
  for (const fullAccess of [false, true]) {
    test(`(c) tipo de fora ${label}${fullAccess ? ', mesmo com o acesso total ligado' : ''}`, { ...WITH_OUTRO, options: { fullAccess } }, async ($, on) => {
      const { ensures, release } = world(on, { agents: [agent('a1', `outro:${name}`)] })
      await opened($)
      await run($, 'a1')
      release()
      expect(ensures().map(body => body.sandbox)).toEqual([sandbox])
    })
  }
}

test('(c) tipo de fora que não passou pelo registro (um agents/*.md de outro plugin): workspace-write, só o papel da ponte', { options: { fullAccess: true } }, async ($, on) => {
  const { ensures, release } = world(on, { agents: [agent('a1', 'outro:arquivo')] })
  await opened($)
  await run($, 'a1')
  release()
  expect(ensures()).toEqual([expect.objectContaining({ sandbox: 'workspace-write', developerInstructions: 'PONTE' })])
})

test('o catálogo do Codex de um tipo de fora fica nas ferramentas que ele registrou', WITH_OUTRO, async ($, on) => {
  const { ensures, release } = world(on, { agents: [agent('a1', 'outro:catalogo')] })
  await opened($)
  await run($, 'a1')
  release()
  expect(ensures()[0]?.dynamicTools).toEqual([expect.objectContaining({ type: 'function', name: 'SendMessage' })])
})

test('o registro guardado no $.state vale depois de recarregar o mod (o tipo que a memória do módulo não tem)', async ($, on) => {
  const { ensures, release } = world(on, { agents: [agent('a1', 'velho:revisor')] })
  on('state.get', async (_$, e, next) => (e.plugin === 'astra' && e.key === 'agents' ? { value: { value: { 'velho:revisor': { prompt: 'GUARDADO', tools: ['Read'] } }, version: 1 } } : next(e)))
  await opened($)
  await run($, 'a1')
  release()
  expect(ensures()).toEqual([expect.objectContaining({ sandbox: 'read-only', developerInstructions: 'PONTE\n\nGUARDADO' })])
})

for (const [label, line, cwd] of [['Linux e macOS', 'cwd: /work/repo', '/work/repo'], ['Windows, com barra invertida', 'cwd: C:\\work\\repo', 'C:\\work\\repo'], ['Windows, com barra', 'cwd: D:/work/repo', 'D:/work/repo']] as const) {
  test(`(d) a pasta de trabalho vem da linha cwd: do 1º pedido (${label})`, async ($, on) => {
    const { ensures, fetched, release } = world(on, { rows: [ask(`${line}\nFaça a tarefa`)], agents: [agent('a1', 'outro:tipo')] })
    await opened($)
    await run($, 'a1')
    release()
    expect(ensures()[0]?.cwd).toBe(cwd)
    expect(fetched.find(entry => entry.path === '/turns')?.body.text).toBe('Faça a tarefa')
  })
}

test('(d) a pasta da linha cwd: vale nos passos seguintes, também depois que o 1º pedido sai do transcript (compactação)', async ($, on) => {
  const given: Given = { rows: [ask('cwd: /work/repo\nFaça a tarefa')], agents: [agent('a1', 'outro:tipo'), agent('a2', 'outro:tipo')] }
  const { ensures, release } = world(on, given)
  await opened($)
  await run($, 'a1')
  // a compactação tirou o 1º pedido: o transcript de a1 começa agora por um pedido sem a linha
  given.rows = [ask('Continue de onde parou')]
  await run($, 'a1')
  // outro agente, que nunca teve a linha, segue na pasta da sessão
  await run($, 'a2')
  release()
  expect(ensures().map(body => [body.key, body.cwd])).toEqual([['a1', '/work/repo'], ['a1', '/work/repo'], ['a2', '/synthetic']])
})

test('o pedido à ponte leva o segredo da sessão; no socket Unix, pelo socketPath', async ($, on) => {
  const { fetched, release } = world(on, {})
  await opened($)
  await run($, undefined)
  release()
  expect(fetched.length).toBeGreaterThan(0)
  for (const entry of fetched) {
    expect(entry.headers['x-astra-secret']).toBe('SEGREDO-DA-SESSAO')
    expect(entry.socketPath).toBe('/run/synthetic/b.sock')
    expect(entry.url.startsWith('http://bridge/')).toBe(true)
  }
})

test('no Windows o READY dá 127.0.0.1 e a porta: o pedido vai a ela, sem socketPath, com o segredo', async ($, on) => {
  const { fetched, release } = world(on, { spawn: { stdout: 'READY http://127.0.0.1:50123 ep1 SEGREDO-TCP\n' } })
  await opened($)
  await run($, undefined)
  release()
  expect(fetched.length).toBeGreaterThan(0)
  for (const entry of fetched) {
    expect(entry.url.startsWith('http://127.0.0.1:50123/')).toBe(true)
    expect(entry.socketPath).toBeUndefined()
    expect(entry.headers['x-astra-secret']).toBe('SEGREDO-TCP')
  }
})

const SETUP = [
  ['sem Node.js: a frase diz que falta e onde baixar', { throws: 'spawn node ENOENT' }, /^\[astra\] Não achei o Node\.js nesta máquina.*https:\/\/nodejs\.org/],
  ['com Node velho: a frase da ponte, como ela a escreveu', { stderr: 'a ponte não subiu: o Node.js desta máquina é a versão 20.1.0, e o astra precisa da 22.18 ou mais nova. Instale a versão LTS em https://nodejs.org e abra o Claude Code de novo.\n' }, /^\[astra\] O Node\.js desta máquina é a versão 20\.1\.0/],
] as const

for (const [label, spawn, expected] of SETUP) {
  test(`falta na máquina, ${label}; nada vai à API`, async ($, on) => {
    const reached: string[] = []
    on('turn.step', async function* (_$, e) {
      reached.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    world(on, { spawn })
    await opened($)
    const result = await run($, undefined)
    expect(result.answer).toMatch(expected)
    expect(reached).toEqual([])
  })
}

test('sem Codex ou sem login: o 503 da ponte vira a frase dela, sem prefixo técnico', async ($, on) => {
  const error = 'O Codex desta máquina está sem login da conta do ChatGPT. Abra um terminal, rode `codex login` e peça de novo.'
  const { release } = world(on, { ensureStatus: { status: 503, error } })
  await opened($)
  const result = await run($, undefined)
  release()
  expect(result.answer).toBe(`[astra] ${error}`)
})

test('a sessão abre limpa: o session.start não abre processo nenhum, nem com o Node e o Codex faltando', async ($, on) => {
  const { fetched } = world(on, { spawn: { throws: 'spawn node ENOENT' } })
  const started = await opened($)
  expect(started).toEqual({ cwd: '/synthetic' })
  expect(fetched).toEqual([])
})

test('(e): ao abrir a sessão o astra registra o comando astra, o sinal de que ele está ligado para outro plugin', async ($, on) => {
  const { commands, release } = world(on, {})
  await opened($)
  release()
  expect(commands).toEqual(['astra'])
})
