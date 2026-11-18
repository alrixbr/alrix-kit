import type { AgentInfo, On, TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { displayText } from '../hooks/activity'
import { agentInfo, bodyText } from './fixtures/agent-info'

const ASTRA: AgentInfo = agentInfo({ id: 'a1', type: 'astra:xhigh', name: 'astra-1', description: 'teste', status: 'running' })
const SOL: AgentInfo = agentInfo({ id: 's1', type: 'astra:sol', name: 'sol-1', description: 'rotina', status: 'running' })
const CLAUDE: AgentInfo = agentInfo({ id: 'c1', type: 'general-purpose', name: 'caixa', description: 'teste', status: 'idle' })
const STEP = { turnId: 'turn-1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 }
const COMMAND_INPUT = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

/**
 * Só dados sintéticos: a lista de agentes e o argv do processo, como `/proc/self/cmdline` o dá (NUL entre os argumentos).
 * `brokenId`: o `$.session.id` falha, como um erro do motor no meio do passo.
 */
function world(on: On, given: { agents: readonly AgentInfo[]; cmdline?: string; brokenId?: boolean }): void {
  on('agent.list', () => ({ value: [...given.agents] }))
  on('session.id', () => {
    if (given.brokenId === true) throw new Error('$.session.id: a sessão não respondeu')
    return { value: 'sessao-1' }
  })
  on('fs.read', (_$, e) => ({ value: e.path.replaceAll('\\', '/').endsWith('/proc/self/cmdline') ? (given.cmdline ?? 'claude\0') : '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
}

/** O modelo Claude no lugar do motor: responde o passo que o mod deixa seguir. */
function byModel(on: On): { calls: number } {
  const seen = { calls: 0 }
  on('turn.step', async function* (_$, e) {
    seen.calls += 1
    yield { kind: 'text', index: 0, text: 'do modelo' }
    return { turnId: e.turnId, index: e.index, answer: 'do modelo', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return seen
}

async function answerOf(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>): Promise<string> {
  for (;;) {
    const next = await stream.next()
    if (next.done === true) return next.value.answer
  }
}

/** O motor no lugar da tela: registra o que o mod pediu ao `$.ui.view` e responde `deny` quando o teste quer. */
function screen(on: On, deny?: string): { views: { agentId?: string }[] } {
  const views: { agentId?: string }[] = []
  on('ui.view', (_$, e) => {
    views.push({ ...e })
    return { value: deny === undefined ? {} : { deny } }
  })
  return { views }
}

async function command($: Engine, args: string): Promise<string> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = await $.command.run({ command: 'astra', args, ...COMMAND_INPUT })
  return (answer as { text?: string } | undefined)?.text ?? ''
}

test('/astra lista só os agentes Astra da sessão', async ($, on) => {
  world(on, { agents: [ASTRA, CLAUDE, SOL] })
  screen(on)
  const text = await command($, '')

  expect(text).toContain('1. `astra-1` · astra:xhigh · running · teste')
  expect(text).toContain('2. `sol-1` · astra:sol · running · rotina')
  expect(text).not.toContain('caixa')
})

test('/astra ver N põe a conversa do agente N na tela; sem N, a do mais recente ativo', async ($, on) => {
  world(on, { agents: [ASTRA, CLAUDE, { ...SOL, status: 'completed' }] })
  const { views } = screen(on)

  expect(await command($, 'ver 2')).toBe('Mostrando a conversa de `sol-1` (astra:sol). Para voltar: `/astra voltar`.')
  expect(await command($, 'ver')).toContain('`astra-1`')
  expect(await command($, 'voltar')).toBe('De volta à conversa principal.')
  expect(views).toEqual([{ agentId: 's1' }, { agentId: 'a1' }, {}])
})

test('/astra ver diz por que não mostrou e lista os agentes quando o número não existe', async ($, on) => {
  world(on, { agents: [ASTRA] })
  const { views } = screen(on, 'not person-initiated')

  expect(await command($, 'ver 1')).toBe('Não deu para mostrar `astra-1`: not person-initiated')
  expect(await command($, 'ver 5')).toContain('Não achei esse agente.')
  expect(views).toHaveLength(1)
})

test('subagente Astra com modelo Claude: o passo fecha com o aviso e nunca vai ao modelo; o de outro tipo segue', async ($, on) => {
  world(on, { agents: [ASTRA, CLAUDE] })
  const model = byModel(on)

  expect(await answerOf($.turn.step({ ...STEP, agentId: 'a1' }))).toBe(
    '[astra] O agente astra:xhigh chegou com o modelo claude-haiku-5-5, que não é do Codex, e o passo não vai ao modelo Claude no lugar dele. '
      + 'Abra o agente de novo com um modelo do Codex (os agentes do astra usam gpt-6.2-astra e gpt-6.2-sol); se a sessão foi aberta antes de atualizar o astra, rode /reload-plugins antes.',
  )
  expect(model.calls).toBe(0)
  expect(await answerOf($.turn.step({ ...STEP, agentId: 'c1' }))).toBe('do modelo')
  expect(model.calls).toBe(1)
})

const MAIN_LOOPS = [
  ['lançado com --agent astra:sol e --model', 'claude\0--agent\0astra:sol\0--model\0opus\0', '[astra] O agente astra:sol chegou com o modelo claude-haiku-5-5'],
  ['sem --agent', 'claude\0-p\0', 'do modelo'],
  ['com o agente de outro plugin', 'claude\0--agent\0x:sol\0', 'do modelo'],
] as const

for (const [label, cmdline, answer] of MAIN_LOOPS) {
  test(`loop principal ${label} e modelo Claude: ${answer === 'do modelo' ? 'segue para o modelo' : 'fecha com o aviso'}`, async ($, on) => {
    world(on, { agents: [], cmdline })
    byModel(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })

    expect(await answerOf($.turn.step(STEP))).toContain(answer)
  })
}

test('loop principal Astra com modelo Claude que quebra antes do aviso: responde o erro e não cai no modelo', async ($, on) => {
  world(on, { agents: [], cmdline: 'claude\0--agent\0astra:sol\0--model\0opus\0', brokenId: true })
  const model = byModel(on)
  // Com o agente guardado no `$.state`, o passo pergunta o id da sessão, e é aí que o motor falha.
  on('state.get', async (_$, e, next) => (e.plugin === 'astra' && e.key === 'mainAgent' ? { value: { value: { sessionId: 'sessao-1', type: 'astra:sol' }, version: 1 } } : next(e)))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false }).catch(() => undefined)

  const answer = await answerOf($.turn.step(STEP))
  expect(answer.startsWith('[astra] O Codex não conseguiu responder a este passo:')).toBe(true)
  expect(answer).toContain('session.id')
  expect(model.calls).toBe(0)
})

test('a linha de andamento mascara credenciais sintéticas, tira controle de terminal e respeita o teto', () => {
  const canaries = [
    ['curl -H "Authorization: Bearer CANARIO-1"', 'Bearer [redacted]'],
    ['export API_TOKEN=CANARIO-2', 'API_TOKEN=[redacted]'],
    ['psql https://usuario:CANARIO-3@db.local/x', 'https://[redacted]@db.local/x'],
    ['GET /x?access_token=CANARIO-4&y=1', '?access_token=[redacted]'],
    ['gh auth --token CANARIO-5', '--token [redacted]'],
    ['password: "CANARIO-6"', 'password: [redacted]'],
  ] as const
  for (const [line, masked] of canaries) {
    expect(displayText(line)).toContain(masked)
    expect(displayText(line)).not.toContain('CANARIO')
  }
  expect(displayText('\x1b[31mvermelho\x1b[0m\tfim')).toBe('vermelho fim')
  expect(displayText('x'.repeat(400))).toBe(`${'x'.repeat(300)}…`)
})
