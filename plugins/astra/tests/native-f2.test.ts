import type { AgentInfo, On, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { buildCatalog, parseSchemas, toolsLine } from '../hooks/catalog'
import { agentInfo, bodyText } from './fixtures/agent-info'

const SESSION = 'synthetic-session'
const STEP = { turnId: 'gpt-turn', index: 0, model: 'gpt-6-astra', effort: 'xhigh' as const, messageCount: 1 }
/** Uma ferramenta de MCP da máquina: o motor não dá o schema dela a um mod, e ela fica fora do catálogo. */
const MCP = 'mcp__notas__buscar'
const OBJECT = { type: 'object', properties: { x: { type: 'string' } } }
const SCHEMAS = JSON.stringify({ tools: [
  { name: 'Agent', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...OBJECT } },
  { name: 'SendMessage', inputSchema: OBJECT },
  { name: 'ListAgents', inputSchema: OBJECT },
  { name: 'Skill', inputSchema: { type: 'string' } },
  { name: 'WebFetch', inputSchema: OBJECT },
  { name: MCP, inputSchema: OBJECT },
  { name: 'Bash', inputSchema: OBJECT },
] })
const LISTED = ['Agent', 'SendMessage', 'ListAgents', 'Skill', 'WebFetch', 'Bash', 'PowerShell', 'Read', 'Edit', 'Write', MCP, 'mcp__context7__query-docs']
  .map(name => ({ name, description: `${name} nesta sessão`, mcp: name.startsWith('mcp__') }))
const REVIEWER = '---\nname: codereviewer\nmodel: gpt-6-astra\ntools: SendMessage, ListAgents, WebFetch\n---\n\nCorpo com tools: Bash\n'
const BUILDER = '---\nname: sol\nmodel: gpt-6.1-sol\neffort: high\n---\n\nCorpo.\n'
const FILES: Readonly<Record<string, string>> = {
  'schemas/claude-tools.json': SCHEMAS,
  'agents/codereviewer.md': REVIEWER,
  'agents/sol.md': BUILDER,
  'roles/bridge.md': 'PONTE\n',
  'roles/native.md': 'BASE NATIVA\n',
  'roles/codereviewer.md': 'PAPEL DO REVISOR\n',
  'roles/native-builder.md': 'PAPEL DO CONSTRUTOR\n',
}
const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const answer = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
const agent = (id: string, type: string): AgentInfo => agentInfo({ id, type, description: 'teste', status: 'running' })

type Posted = { path: string; body: Record<string, unknown> }
/** `cmdline`: o argv do processo como `/proc/self/cmdline` o dá (NUL entre os argumentos). */
type Given = { rows: readonly SessionMessage[]; agents: readonly AgentInfo[]; missing?: readonly string[]; cmdline?: string }

// Só dados sintéticos: a ponte é o `process.spawn` que diz READY, e o socket é o `http.fetch`, que fecha o turno no 1º lote.
function world(on: On, given: Given) {
  mock.clock(on)
  const posted: Posted[] = []
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/synthetic' }))
  on('session.messages', (_$, e) => ({ value: e.as === 'api' ? [] : [...given.rows] }))
  on('tool.list', () => ({ value: LISTED }))
  on('agent.list', () => ({ value: [...given.agents] }))
  on('fs.exists', (_$, e) => ({ value: !(given.missing ?? []).some(path => e.path.replaceAll('\\', '/').endsWith(path)) }))
  on('fs.read', (_$, e) => {
    // O caminho chega no separador do sistema (barra invertida no Windows): o teste compara com `/`.
    const path = e.path.replaceAll('\\', '/')
    const file = Object.keys(FILES).find(name => path.endsWith(`/${name}`))
    return { value: (file === undefined ? undefined : FILES[file]) ?? (path.endsWith('/proc/self/cmdline') ? (given.cmdline ?? 'claude\0') : '') }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'READY /run/synthetic/b-ep1.sock ep1 SEGREDO\n' }
    await held
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const path = e.url.replace('http://bridge', '')
    if (path.startsWith('/events')) return answer({ events: [{ kind: 'text', delta: 'Feito.', seq: 1 }, { kind: 'done', status: 'completed', seq: 2 }], next: 2 })
    posted.push({ path, body: JSON.parse(bodyText(e.init?.body)) as Record<string, unknown> })
    if (path === '/threads/ensure') return answer({ threadId: 'thr-1', isNew: true })
    return answer({ turnId: 'cx-1', seq: 0 })
  })
  return { posted, release }
}

async function run($: Engine, agentId: string | undefined): Promise<TurnStepResult> {
  await $.session.start({ cwd: '/synthetic', surface: null, isInteractive: false })
  const stream: AsyncGenerator<TurnStepChunk, TurnStepResult> = $.turn.step(agentId === undefined ? STEP : { ...STEP, agentId })
  for (;;) {
    const item = await stream.next()
    if (item.done) return item.value
  }
}

const namesOf = (tools: readonly unknown[]): readonly unknown[] =>
  tools.map(tool => (typeof tool === 'object' && tool !== null && 'tools' in tool && Array.isArray(tool.tools) ? namesOf(tool.tools) : (tool as { name?: unknown }).name))

test('catálogo: as diretas à vista, o resto no namespace com deferLoading, e só o que tem schema de objeto', () => {
  const { dynamicTools, names } = buildCatalog(LISTED, parseSchemas(SCHEMAS))
  expect(namesOf(dynamicTools)).toEqual(['Agent', 'SendMessage', 'ListAgents', ['WebFetch']])
  expect(dynamicTools[0]).toEqual({ type: 'function', name: 'Agent', description: 'Agent nesta sessão', inputSchema: OBJECT })
  const namespace = dynamicTools[3] as { type?: unknown; name?: unknown; tools?: readonly { deferLoading?: unknown }[] }
  expect(namespace).toMatchObject({ type: 'namespace', name: 'claude_code' })
  expect(namespace.tools?.map(tool => tool.deferLoading)).toEqual([true])
  // O shell (Bash, PowerShell), Read, Edit e Write o Codex já tem; MCP fica fora, mesmo com schema no arquivo.
  for (const name of ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'mcp_notas__buscar', MCP]) expect(names.has(name)).toBe(false)
})

test('tools: do agente filtra o catálogo; sem a linha, ou com ela só no corpo, não filtra', () => {
  const allowed = toolsLine(REVIEWER)
  expect(allowed).toEqual(new Set(['SendMessage', 'ListAgents', 'WebFetch']))
  expect(namesOf(buildCatalog(LISTED, parseSchemas(SCHEMAS), allowed).dynamicTools)).toEqual(['SendMessage', 'ListAgents', ['WebFetch']])
  expect(toolsLine('---\ntools: ["SendMessage", "Agent"]\n---\n')).toEqual(new Set(['SendMessage', 'Agent']))
  expect(toolsLine(BUILDER)).toBeUndefined()
})

test('revisor: thread em read-only, com o papel nativo, as ferramentas do arquivo dele e o cwd da linha cwd:', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('cwd: /work/repo\nRevise o diff')], agents: [agent('agent-r', 'astra:codereviewer')] })
  const result = await run($, 'agent-r')
  release()
  const ensure = posted.find(entry => entry.path === '/threads/ensure')?.body
  expect(ensure).toMatchObject({ key: 'agent-r', cwd: '/work/repo', model: 'gpt-6-astra', sandbox: 'read-only', developerInstructions: 'PONTE\n\nBASE NATIVA\n\nPAPEL DO REVISOR' })
  expect(namesOf((ensure?.dynamicTools ?? []) as unknown[])).toEqual(['SendMessage', 'ListAgents', ['WebFetch']])
  expect(posted.find(entry => entry.path === '/turns')?.body).toMatchObject({ key: 'agent-r', text: 'Revise o diff', effort: 'xhigh' })
  expect(result.answer).toBe('Feito.')
})

test('construtor: workspace-write por padrão, papel de construtor, catálogo inteiro e o cwd da sessão', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('Corrija o teste')], agents: [agent('agent-s', 'astra:sol')] })
  await run($, 'agent-s')
  release()
  const ensure = posted.find(entry => entry.path === '/threads/ensure')?.body
  expect(ensure).toMatchObject({ cwd: '/synthetic', sandbox: 'workspace-write', developerInstructions: 'PONTE\n\nBASE NATIVA\n\nPAPEL DO CONSTRUTOR' })
  expect(namesOf((ensure?.dynamicTools ?? []) as unknown[])).toEqual(['Agent', 'SendMessage', 'ListAgents', ['WebFetch']])
})

test('construtor com a opção fullAccess ligada: acesso total; o revisor segue em read-only', { options: { fullAccess: true } }, async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('Corrija o teste')], agents: [agent('agent-s', 'astra:sol'), agent('agent-r', 'astra:codereviewer')] })
  await run($, 'agent-s')
  await run($, 'agent-r')
  release()
  expect(posted.filter(entry => entry.path === '/threads/ensure').map(entry => entry.body.sandbox)).toEqual(['danger-full-access', 'read-only'])
})

const LAUNCHES = [
  ['loop principal lançado com --agent', 'claude\0--agent\0astra:codereviewer\0-p\0'],
  ['teammate em painel (--agent-type com a equipe)', 'claude\0--agent-id\0r@t\0--agent-name\0r\0--team-name\0t\0--agent-type\0astra:codereviewer\0'],
] as const

for (const [label, cmdline] of LAUNCHES) {
  test(`revisor como ${label}: read-only, o papel e as ferramentas dele, e a linha cwd:`, async ($, on) => {
    const { posted, release } = world(on, { rows: [ask('cwd: /work/repo\nRevise o diff')], agents: [], cmdline })
    const result = await run($, undefined)
    release()
    const ensure = posted.find(entry => entry.path === '/threads/ensure')?.body
    expect(ensure).toMatchObject({ key: `main:${SESSION}`, cwd: '/work/repo', sandbox: 'read-only', developerInstructions: 'PONTE\n\nBASE NATIVA\n\nPAPEL DO REVISOR' })
    expect(namesOf((ensure?.dynamicTools ?? []) as unknown[])).toEqual(['SendMessage', 'ListAgents', ['WebFetch']])
    expect(result.answer).toBe('Feito.')
  })
}

const REVIEWER_ROLE = 'PONTE\n\nBASE NATIVA\n\nPAPEL DO REVISOR'
const BUILDER_ROLE = 'PONTE\n\nBASE NATIVA\n\nPAPEL DO CONSTRUTOR'

/** O pedido chegando ao Claude Code, com o agente que ele resolveu: é o UserPromptSubmit que o mod observa. */
async function submitted($: Engine, on: On, input: { agent_type?: string; agent_id?: string }): Promise<void> {
  on('classic.UserPromptSubmit', () => ({}))
  await $.classic.UserPromptSubmit({ prompt: 'Revise o diff', ...input })
}

/** O `$.state` que sobreviveu ao recarregamento do mod: o agente que o motor resolveu numa sessão. */
function keptAgent(on: On, mainAgent: { sessionId: string; type: string | null }): void {
  on('state.get', async (_$, e, next) => (e.plugin === 'astra' && e.key === 'mainAgent' ? { value: { value: mainAgent, version: 1 } } : next(e)))
}

const rolesOf = (posted: readonly Posted[]): unknown[] => posted.filter(entry => entry.path === '/threads/ensure').map(entry => entry.body.developerInstructions)

const RESOLVED = [
  ['--agent sol, nome curto, que o Claude Code resolveu para astra:sol', 'claude\0--agent\0sol\0', 'astra:sol', BUILDER_ROLE],
  ['--resume sem --agent, com o astra:codereviewer que o Claude Code restaurou', 'claude\0--resume\0s1\0', 'astra:codereviewer', REVIEWER_ROLE],
  ['--agent sol que o Claude Code deu ao x:sol de outro plugin', 'claude\0--agent\0sol\0', 'x:sol', 'PONTE'],
] as const

for (const [label, cmdline, agentType, role] of RESOLVED) {
  test(`loop principal com ${label}: o papel da thread segue o agente resolvido`, async ($, on) => {
    const { posted, release } = world(on, { rows: [ask('Revise o diff')], agents: [], cmdline })
    await submitted($, on, { agent_type: agentType })
    await run($, undefined)
    release()
    expect(rolesOf(posted)).toEqual([role])
  })
}

test('o pedido de um subagente (agent_id) não muda o agente do loop principal', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('Revise o diff')], agents: [], cmdline: 'claude\0-p\0' })
  await submitted($, on, { agent_id: 'a1', agent_type: 'astra:codereviewer' })
  await run($, undefined)
  release()
  expect(rolesOf(posted)).toEqual(['PONTE'])
})

test('recarregado no meio da sessão (session.start de novo, sem pedido novo): o loop principal segue o agente resolvido', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('Revise o diff')], agents: [], cmdline: 'claude\0--resume\0s1\0' })
  await submitted($, on, { agent_type: 'astra:codereviewer' })
  await run($, undefined)
  await run($, undefined)
  release()
  expect(posted.filter(entry => entry.path === '/turns')).toHaveLength(2)
  expect(new Set(rolesOf(posted))).toEqual(new Set([REVIEWER_ROLE]))
})

const KEPT = [
  ['desta sessão vale: o --resume segue o astra:codereviewer', SESSION, 'claude\0--resume\0s1\0', REVIEWER_ROLE],
  ['de outra sessão (de antes do /clear) não vale: sem agente no argv, sem papel', 'sessao-0', 'claude\0-p\0', 'PONTE'],
] as const

for (const [label, sessionId, cmdline, role] of KEPT) {
  test(`recarregado do zero, sem pedido novo: o $.state ${label}`, async ($, on) => {
    const { posted, release } = world(on, { rows: [ask('Revise o diff')], agents: [], cmdline })
    keptAgent(on, { sessionId, type: 'astra:codereviewer' })
    await run($, undefined)
    release()
    expect(rolesOf(posted)).toEqual([role])
  })
}

test('--agent sol só no argv: o mod não resolve o nome curto, que o Claude Code pode ter dado a outro plugin', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('Revise o diff')], agents: [], cmdline: 'claude\0--agent\0sol\0' })
  await run($, undefined)
  release()
  expect(rolesOf(posted)).toEqual(['PONTE'])
})

test('sem saber o papel, o passo recusa sem abrir thread: subagente fora da lista e tipo astra:* sem perfil', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('Faça')], agents: [agent('agent-n', 'astra:novo')] })
  const unlisted = await run($, 'agent-x')
  const unknown = await run($, 'agent-n')
  release()
  expect(unlisted.answer).toBe('[astra] O agente agent-x não está na lista da sessão; sem saber o papel dele, o passo não abre o Codex.')
  expect(unknown.answer).toBe('[astra] O agente astra:novo não tem perfil no mod (hooks/profiles.ts); sem o papel e o sandbox dele, o passo não abre o Codex.')
  expect(posted).toEqual([])
})

test('loop principal sem agente e agente de outro tipo que não se registrou: workspace-write, só o texto da ponte', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('Olhe o projeto')], agents: [agent('agent-g', 'general-purpose')] })
  await run($, 'agent-g')
  await run($, undefined)
  release()
  const ensures = posted.filter(entry => entry.path === '/threads/ensure').map(entry => entry.body)
  expect(ensures.map(body => body.key)).toEqual(['agent-g', `main:${SESSION}`])
  for (const body of ensures) {
    expect(body.sandbox).toBe('workspace-write')
    expect(body.developerInstructions).toBe('PONTE')
  }
})

test('linha cwd: com um diretório que não existe: o passo recusa sem abrir thread', async ($, on) => {
  const { posted, release } = world(on, { rows: [ask('cwd: /nao/existe\nFaça')], agents: [agent('agent-s', 'astra:sol')], missing: ['/nao/existe'] })
  const result = await run($, 'agent-s')
  release()
  expect(result.answer).toBe('[astra] O diretório de trabalho do pedido não existe: /nao/existe')
  expect(posted).toEqual([])
})
