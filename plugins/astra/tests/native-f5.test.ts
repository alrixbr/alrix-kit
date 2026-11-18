import type { On, SessionAppendInput, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { CONTEXT_LABEL, contextText, reminderBlocks } from '../hooks/native-context'
import { agentInfo, bodyText } from './fixtures/agent-info'

// F5, com dados sintéticos e a ponte falsa de native-f4.test.ts: o recado que vai ao turno do Codex na hora (steer
// amarrado ao turno, sem repetir depois) e o contexto do Claude Code que vai ao Codex.

const SESSION = 'synthetic-session'
const MAIN = `main:${SESSION}`
const STEP = { turnId: 'gpt-turn', index: 0, model: 'gpt-6.1-sol', effort: 'low' as const, messageCount: 1 }
const MEMORY = 'WebFetch'
const CODEX_MEMORY = 'WebFetch'
const OBJECT = { type: 'object', properties: { consulta: { type: 'string' } } }
const CATALOG = JSON.stringify({ tools: [{ name: MEMORY, inputSchema: OBJECT }] })
const ID = 'toolu_astra_gptturn_0_0'
const ask = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const said = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const asked = (tool: string): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool, tool_use_id: ID, input: { consulta: 'astra' } }] })
const result = (text: string): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: ID, text, isError: false }] })
const TOOL_CALL = { kind: 'toolCall', callId: 'call-1', tool: CODEX_MEMORY, args: { consulta: 'astra' } }
const DONE = { kind: 'done', status: 'completed' }
const TYPED = { wait: false, origin: { kind: 'composer' as const } }
const STEERED = '[astra] O Codex recebeu este recado no turno anterior, enquanto trabalhava, e a resposta acima já o leva em conta.'

type Posted = { path: string; body: Record<string, unknown> }
/** Um lote de eventos, ou a função que o entrega quando o teste deixa (o turno do Codex calado num comando do shell). */
type Batch = readonly object[] | (() => Promise<readonly object[]>)
type Api = { role: 'user' | 'assistant'; content: { type: string; text?: string }[] }
type Given = { batches: readonly Batch[]; rows?: readonly SessionMessage[]; api?: readonly Api[]; status?: Readonly<Record<string, number>>; steer?: Promise<void> }

const answer = (status: number, body: unknown) => ({ value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } })

/** Uma porta que o teste abre: `opened` resolve quando o código chegou nela, e `open()` a deixa passar. */
function gate(): { opened: Promise<void>; reach: () => void; wait: Promise<void>; open: () => void } {
  let reach = (): void => {}
  let open = (): void => {}
  const opened = new Promise<void>(resolve => {
    reach = resolve
  })
  const wait = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, reach, wait, open }
}

function world(on: On, given: Given) {
  const clock = mock.clock(on)
  mock.session(on)
  const posted: Posted[] = []
  const steering = gate()
  const state = { rows: given.rows ?? [ask('Busque na memória por astra')], api: given.api ?? [], served: 0, seq: 0, ensured: new Set<string>(), status: given.status ?? {} }
  const agents = [agentInfo({ id: 'agent-1', type: 'general-purpose', description: 'teste', status: 'running' })]
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  // `crash` derruba a 1ª ponte; a seguinte nasce com outra época.
  const crash = gate()
  let spawned = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/synthetic' }))
  on('session.model', () => ({ value: 'gpt-6.1-sol' }))
  on('tool.list', () => ({ value: [{ name: MEMORY, description: 'Busca.', mcp: false }] }))
  on('session.messages', (_$, e) => ({ value: e.as === 'api' ? [...state.api] : [...state.rows] }))
  on('agent.list', () => ({ value: agents }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('fs.read', (_$, e) => ({ value: e.path.replaceAll('\\', '/').endsWith('schemas/claude-tools.json') ? CATALOG : e.path.replaceAll('\\', '/').endsWith('/proc/self/cmdline') ? 'claude\0' : '' }))
  on('process.spawn', async function* () {
    spawned += 1
    yield { stream: 'stdout' as const, text: `READY /run/synthetic/b-ep${spawned}.sock ep${spawned} SEGREDO${spawned}\n` }
    await (spawned === 1 ? Promise.race([held, crash.wait]) : held)
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const path = e.url.replace('http://bridge', '')
    if (path.startsWith('/events')) {
      // Passado o último lote, o turno do Codex fecha: o mod que abriria um turno a mais falha no teste, sem ficar lendo.
      const batch = given.batches[state.served] ?? [DONE]
      state.served += 1
      const events = (typeof batch === 'function' ? await batch() : batch).map(event => ({ ...event, seq: ++state.seq }))
      return answer(200, { events, next: state.seq })
    }
    const body = JSON.parse(bodyText(e.init?.body)) as Record<string, unknown>
    posted.push({ path, body })
    if (path === '/steer' && given.steer !== undefined) {
      steering.reach()
      await given.steer
    }
    const status = state.status[path] ?? 200
    if (status !== 200) return answer(status, { error: `a ponte falsa responde ${status}` })
    if (path === '/threads/ensure') {
      const isNew = !state.ensured.has(String(body.key))
      state.ensured = new Set([...state.ensured, String(body.key)])
      return answer(200, { threadId: 'thr-1', isNew })
    }
    if (path === '/turns') return answer(200, { turnId: 'cx-1', seq: state.seq })
    return answer(200, {})
  })
  return { posted, release, state, steering, crash: crash.open, clock }
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
const reminder = (text: string): string => `<system-reminder id="r1">\n${text}\n</system-reminder id="r1">`

/** Uma linha que o Claude Code anexa à conversa (o 2.1.310 na sonda de 25/10): a entrega, o contexto ou o de um hook. */
const row = (door: 'delivery' | 'attachment' | 'hook-context', text: string, agentId?: string): SessionAppendInput => ({
  message: { type: 'attachment', name: door === 'delivery' ? 'queued_command' : 'nested_memory', role: 'user', isMeta: true, content: [{ type: 'text', text: door === 'hook-context' ? text : reminder(text) }] },
  door,
  origin: { kind: 'coordinator' },
  uuid: `u-${door}-${text.length}`,
  ...(agentId === undefined ? {} : { agentId }),
})
/** A entrega de um recado digitado, na fronteira de uma ferramenta, como a sonda de 25/10 a mediu (uma por recado). */
const typedDelivery = (text: string): SessionAppendInput =>
  row(
    'delivery',
    `The user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`,
  )

test('recado digitado com o turno do Codex esperando uma ferramenta: vai por /steer amarrado ao turno, e a entrega não repete', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[TOOL_CALL], [{ kind: 'text', delta: 'Azul.' }, DONE]] })
  await opened($)
  await step($.turn.step(STEP))
  await $.prompt.submit({ text: ' mude para azul ', turnId: 'gpt-turn', ...TYPED })
  await $.session.append(typedDelivery('mude para azul'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  const second = await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/tool-result'])
  expect(posted[2]?.body).toEqual({ key: MAIN, text: 'A pessoa mandou um recado enquanto você trabalhava:\nmude para azul', turnId: 'cx-1' })
  expect(second.answer).toBe('Azul.')
})

test('depois da 1ª rodada de ferramentas, o turno do Codex que segue recebe o steer amarrado ao mesmo id', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[TOOL_CALL], [{ ...TOOL_CALL, callId: 'call-2' }]] })
  await opened($)
  await step($.turn.step(STEP))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  await $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/tool-result', '/steer'])
  expect(posted[3]?.body.turnId).toBe('cx-1')
})

test('recado durante um comando do shell do Codex: entra no mesmo turno, e o turno que a fila abre com ele fecha sem ir ao Codex', async ($, on) => {
  const shell = gate()
  const { posted, release, state } = world(on, {
    batches: [async () => {
      shell.reach()
      await shell.wait
      return [{ kind: 'text', delta: 'Feito, em azul.' }, DONE]
    }],
  })
  await opened($)
  const running = step($.turn.step(STEP))
  await shell.opened
  await $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED, origin: { kind: 'bridge' } })
  shell.open()
  const first = await running
  state.rows = [...state.rows, said('Feito, em azul.'), ask('mude para azul')]
  const second = await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer'])
  expect(posted[2]?.body).toMatchObject({ key: MAIN, turnId: 'cx-1' })
  expect(first.answer).toBe('Feito, em azul.')
  expect(second.answer).toBe(STEERED)
})

test('o turno novo leva só o que não foi por steer: o recado anotado sai do pedido, e o resto vai', async ($, on) => {
  const shell = gate()
  const { posted, release, state } = world(on, {
    batches: [async () => {
      shell.reach()
      await shell.wait
      return [DONE]
    }, [DONE]],
  })
  await opened($)
  const running = step($.turn.step(STEP))
  await shell.opened
  await $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  shell.open()
  await running
  state.rows = [...state.rows, said('Ok.'), ask('e confira o teste\n\n  mude para azul\t\n\nobrigado')]
  await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  release()
  expect(posted.at(-1)).toEqual({ path: '/turns', body: { key: MAIN, text: 'e confira o teste\n\nobrigado', model: 'gpt-6.1-sol', effort: 'low', owner: 'gpt-turn-2' } })
})

test('fora do turno do Codex, com wait, comando, anexo, de outra origem ou sem turno: o recado segue a fila, sem steer', async ($, on) => {
  const { posted, release } = world(on, { batches: [[TOOL_CALL]] })
  await opened($)
  await step($.turn.step(STEP))
  await $.prompt.submit({ text: 'de outro turno', turnId: 'outro-turno', ...TYPED })
  await $.prompt.submit({ text: 'espere a vez', turnId: 'gpt-turn', ...TYPED, wait: true })
  await $.prompt.submit({ text: '/compact', turnId: 'gpt-turn', ...TYPED, command: { name: 'compact', args: '' } })
  await $.prompt.submit({ text: 'veja a imagem', turnId: 'gpt-turn', ...TYPED, attachments: [{ type: 'image' }] })
  await $.prompt.submit({ text: 'aviso de tarefa', turnId: 'gpt-turn', ...TYPED, origin: { kind: 'task-notification' } })
  await $.prompt.submit({ text: '   ', turnId: 'gpt-turn', ...TYPED })
  await $.prompt.submit({ text: 'com a sessão parada', ...TYPED })
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns'])
})

test('a ponte recusa o steer (o turno do Codex já fechou): o recado segue o caminho normal, pela caixa', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[TOOL_CALL], [DONE]], status: { '/steer': 409 } })
  await opened($)
  await step($.turn.step(STEP))
  await $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  await $.session.append(typedDelivery('mude para azul'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/tool-result', '/steer'])
  expect(String(posted[4]?.body.text)).toContain('\nmude para azul\n')
})

test('a entrega que chega enquanto o steer corre espera a resposta da ponte: aceito, ela não vai de novo', async ($, on) => {
  const answered = gate()
  const { posted, release, state, steering } = world(on, { batches: [[TOOL_CALL], [DONE]], steer: answered.wait })
  await opened($)
  await step($.turn.step(STEP))
  const submitting = $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  await steering.opened
  const appending = $.session.append(typedDelivery('mude para azul'))
  answered.open()
  await Promise.all([submitting, appending])
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/tool-result'])
})

test('a entrega que chega enquanto o steer corre, e a ponte recusa: ela vai pela caixa', async ($, on) => {
  const answered = gate()
  const { posted, release, state, steering } = world(on, { batches: [[TOOL_CALL], [DONE]], steer: answered.wait, status: { '/steer': 409 } })
  await opened($)
  await step($.turn.step(STEP))
  const submitting = $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  await steering.opened
  const appending = $.session.append(typedDelivery('mude para azul'))
  answered.open()
  await Promise.all([submitting, appending])
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/tool-result', '/steer'])
})

test('a ponte reinicia depois do steer: a anotação da antiga não vale, e a entrega vai ao turno da ponte nova', async ($, on) => {
  const { posted, release, state, crash, clock } = world(on, { batches: [[TOOL_CALL], [DONE]] })
  await opened($)
  await step($.turn.step(STEP))
  await $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  // A 1ª ponte sai; o mod a vê sair quando o event loop assenta.
  crash()
  await clock.settle()
  await $.session.append(typedDelivery('mude para azul'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/threads/ensure', '/turns'])
  expect(String(posted.at(-1)?.body.text)).toContain('\nmude para azul\n')
})

test('turno do Codex interrompido depois do steer: a anotação cai, e o recado vai no turno seguinte', async ($, on) => {
  const shell = gate()
  const { posted, release, state } = world(on, {
    batches: [async () => {
      shell.reach()
      await shell.wait
      return [{ kind: 'done', status: 'interrupted' }]
    }, [DONE]],
  })
  await opened($)
  const running = step($.turn.step(STEP))
  await shell.opened
  await $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  shell.open()
  await running
  state.rows = [...state.rows, said(''), ask('mude para azul')]
  const second = await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/threads/ensure', '/turns'])
  expect(posted.at(-1)?.body.text).toBe('mude para azul')
  expect(second.answer).not.toBe(STEERED)
})

test('a ponte cai no meio do turno depois do steer: o turno fecha, a anotação cai, e o recado vai no turno seguinte', async ($, on) => {
  const shell = gate()
  const { posted, release, state } = world(on, {
    batches: [async () => {
      shell.reach()
      await shell.wait
      throw new Error('a ponte caiu')
    }, [DONE]],
  })
  await opened($)
  const running = step($.turn.step(STEP))
  await shell.opened
  await $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED })
  shell.open()
  await running
  await $.prompt.submit({ text: 'tarde demais', turnId: 'gpt-turn', ...TYPED })
  state.rows = [...state.rows, said(''), ask('mude para azul')]
  await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/interrupt', '/threads/ensure', '/turns'])
  expect(posted.at(-1)?.body.text).toBe('mude para azul')
})

/** Um lote que segura o turno do Codex calado (num comando do shell dele) até o teste abrir `shell`. */
const quiet = (shell: ReturnType<typeof gate>, events: readonly object[]): Batch => async () => {
  shell.reach()
  await shell.wait
  return events
}

test('dois recados de mesmo texto, o 1º aceito e o 2º recusado: o turno da fila leva só o recusado', async ($, on) => {
  const shell = gate()
  const { posted, release, state } = world(on, { batches: [quiet(shell, [DONE]), [DONE]] })
  await opened($)
  const running = step($.turn.step(STEP))
  await shell.opened
  await $.prompt.submit({ text: 'continue', turnId: 'gpt-turn', ...TYPED })
  state.status = { '/steer': 409 }
  await $.prompt.submit({ text: 'continue', turnId: 'gpt-turn', ...TYPED })
  state.status = {}
  shell.open()
  await running
  state.rows = [...state.rows, said('Ok.'), ask('continue\n\ncontinue')]
  await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/steer', '/threads/ensure', '/turns'])
  expect(posted.at(-1)?.body.text).toBe('continue')
})

test('o steer recusado não deixa anotação: tirado da fila, ele não faz o de mesmo texto, aceito depois, ir de novo', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[TOOL_CALL], [DONE]], status: { '/steer': 409 } })
  await opened($)
  await step($.turn.step(STEP))
  await $.prompt.submit({ text: 'continue', turnId: 'gpt-turn', ...TYPED })
  // A pessoa tira o 1º da fila com a seta para cima, e ele não é entregue; o 2º vai por steer.
  state.status = {}
  await $.prompt.submit({ text: 'continue', turnId: 'gpt-turn', ...TYPED })
  await $.session.append(typedDelivery('continue'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/steer', '/tool-result'])
})

test('o recado aceito que a pessoa tirou da fila não engole o pedido novo de mesmo texto', async ($, on) => {
  const shell = gate()
  const { posted, release, state } = world(on, { batches: [quiet(shell, [{ kind: 'text', delta: 'Ok.' }, DONE]), [{ kind: 'text', delta: 'Sigo.' }, DONE]] })
  await opened($)
  const running = step($.turn.step(STEP))
  await shell.opened
  await $.prompt.submit({ text: 'sim', turnId: 'gpt-turn', ...TYPED })
  shell.open()
  await running
  // O recado saiu da fila sem ser entregue, e o turno acabou; o pedido seguinte é novo.
  await $.prompt.submit({ text: 'sim', ...TYPED })
  state.rows = [...state.rows, said('Ok.'), ask('sim')]
  const second = await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  release()
  expect(posted.at(-1)).toMatchObject({ path: '/turns', body: { text: 'sim' } })
  expect(second.answer).toBe('Sigo.')
})

test('o aviso de uma tarefa que abre turno não derruba a anotação: o turno da fila não repete o recado', async ($, on) => {
  const shell = gate()
  const { posted, release, state } = world(on, { batches: [quiet(shell, [DONE])] })
  await opened($)
  const running = step($.turn.step(STEP))
  await shell.opened
  await $.prompt.submit({ text: 'sim', turnId: 'gpt-turn', ...TYPED })
  shell.open()
  await running
  await $.prompt.submit({ text: '<task-notification>fim</task-notification>', wait: false, origin: { kind: 'task-notification' } })
  state.rows = [...state.rows, said('Ok.'), ask('sim')]
  const second = await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer'])
  expect(second.answer).toBe(STEERED)
})

test('a ponte não responde ao steer em 5 s: o recado entra na fila e vai pela caixa', async ($, on) => {
  const answered = gate()
  const { posted, release, state, steering, clock } = world(on, { batches: [[TOOL_CALL], [DONE]], steer: answered.wait })
  await opened($)
  await step($.turn.step(STEP))
  let isBack = false
  const submitting = $.prompt.submit({ text: 'mude para azul', turnId: 'gpt-turn', ...TYPED }).then(() => {
    isBack = true
  })
  await steering.opened
  await clock.settle()
  await clock.advance(4_999)
  const isEarly = isBack
  await clock.advance(1)
  const isInTime = isBack
  // A ponte responde tarde: o aceite que chega depois do prazo não muda nada.
  answered.open()
  await submitting
  await $.session.append(typedDelivery('mude para azul'))
  state.rows = [...state.rows, asked(MEMORY), result('Astra em worktree')]
  await step($.turn.step({ ...STEP, index: 1, messageCount: 3 }))
  release()
  expect([isEarly, isInTime]).toEqual([false, true])
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns', '/steer', '/tool-result', '/steer'])
  expect(String(posted[4]?.body.text)).toContain('\nmude para azul\n')
})

test('turno do Codex já fechado: o recado com o mesmo turnId do Claude Code não vai por steer', async ($, on) => {
  const { posted, release } = world(on, { batches: [[{ kind: 'text', delta: 'Pronto.' }, DONE]] })
  await opened($)
  await step($.turn.step(STEP))
  await $.prompt.submit({ text: 'depois do fim', turnId: 'gpt-turn', ...TYPED })
  release()
  expect(paths(posted)).toEqual(['/threads/ensure', '/turns'])
})

const API: readonly Api[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: reminder('The following deferred tools are now available via ToolSearch.\nmcp__x__y') },
      { type: 'text', text: reminder('# Environment\nPrimary working directory: /synthetic') },
      { type: 'text', text: reminder('Codebase and user instructions are shown below.\nContents of /synthetic/CLAUDE.md:\nA palavra-código é JABUTICABA.') },
      { type: 'text', text: reminder('The following skills are available for use with the Skill tool:\n- brief') },
      { type: 'text', text: 'Busque na memória por astra' },
    ],
  },
]
const CLAUDE_MD = 'Codebase and user instructions are shown below.\nContents of /synthetic/CLAUDE.md:\nA palavra-código é JABUTICABA.'
const SKILLS = 'The following skills are available for use with the Skill tool:\n- brief'

test('thread nova: o contexto do formato da API vai rotulado no 1º turno, sem as ferramentas adiadas e sem o ambiente', async ($, on) => {
  const { posted, release } = world(on, { batches: [[DONE]], api: API })
  await opened($)
  await step($.turn.step(STEP))
  release()
  expect(posted[1]?.body.text).toBe([CONTEXT_LABEL, CLAUDE_MD, SKILLS, 'Busque na memória por astra'].join('\n\n'))
})

test('thread que já existe: vão as linhas novas de contexto do loop GPT, uma vez; as de um loop Claude e as filtradas, não', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[DONE], [DONE], [DONE]] })
  await opened($)
  await $.session.append(row('attachment', 'Antes do 1º passo GPT: a thread nova lê o formato da API.'))
  await step($.turn.step(STEP))
  await $.session.append(row('attachment', 'Contents of /synthetic/sub/CLAUDE.md:\nregra nova'))
  await $.session.append(row('attachment', 'The following deferred tools are now available via ToolSearch.\nmcp__x__y'))
  await $.session.append(row('hook-context', 'Contexto de um hook, sem lembrete.'))
  await $.session.append(row('attachment', 'De um subagente Claude.', 'agent-claude'))
  state.rows = [...state.rows, said('Ok.'), ask('e agora?')]
  await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  state.rows = [...state.rows, said('Ok.'), ask('e de novo?')]
  await step($.turn.step({ ...STEP, turnId: 'gpt-turn-3', messageCount: 5 }))
  release()
  const turns = posted.filter(entry => entry.path === '/turns').map(entry => entry.body.text)
  expect(turns).toEqual(['Busque na memória por astra', [CONTEXT_LABEL, 'Contents of /synthetic/sub/CLAUDE.md:\nregra nova', 'Contexto de um hook, sem lembrete.', 'e agora?'].join('\n\n'), 'e de novo?'])
})

test('o turno que não abre (a ponte falhou no /turns) não perde o contexto da caixa', async ($, on) => {
  const { posted, release, state } = world(on, { batches: [[DONE], [DONE]] })
  await opened($)
  await step($.turn.step(STEP))
  await $.session.append(row('attachment', 'regra nova'))
  state.rows = [...state.rows, said('Ok.'), ask('e agora?')]
  state.status = { '/turns': 500 }
  const failed = await step($.turn.step({ ...STEP, turnId: 'gpt-turn-2', messageCount: 3 }))
  state.status = {}
  await step($.turn.step({ ...STEP, turnId: 'gpt-turn-3', messageCount: 3 }))
  release()
  expect(failed.answer).toContain('[astra] O Codex não conseguiu responder a este passo')
  expect(posted.at(-1)?.body.text).toBe([CONTEXT_LABEL, 'regra nova', 'e agora?'].join('\n\n'))
})

test('contextText: sem repetir bloco nem o que já vai como recado; passando do teto, ficam o começo e os mais novos, com o aviso', () => {
  expect(contextText([], [])).toBe('')
  expect(contextText(['a', 'b', 'a', 'recado'], ['recado'])).toBe([CONTEXT_LABEL, 'a', 'b'].join('\n\n'))
  // Cabeça de 100 mil: a (60 mil) e b (30 mil). O resto do teto (60 mil) vai aos mais novos: e (20 mil) e d (40 mil).
  const [a, b, c, d, e] = ['a'.repeat(60_000), 'b'.repeat(30_000), 'c'.repeat(40_000), 'd'.repeat(40_000), 'e'.repeat(20_000)] as const
  const note = '[astra] 1 bloco(s) de contexto do meio ficaram de fora (teto de 150000 caracteres: ficam o começo e os mais novos).'
  expect(contextText([a, b, c, d, e], [])).toBe([CONTEXT_LABEL, a, b, d, e, note].join('\n\n'))
})

test('reminderBlocks: só os lembretes dos textos do usuário, cada um à parte, sem os filtrados', () => {
  const messages: readonly Api[] = [
    { role: 'user', content: [{ type: 'text', text: `${reminder('um')}\n${reminder('dois')}` }, { type: 'image' }, { type: 'text', text: 'o pedido' }] },
    { role: 'assistant', content: [{ type: 'text', text: reminder('da resposta') }] },
    { role: 'user', content: [{ type: 'tool_result' }, { type: 'text', text: reminder('# Environment\ncwd') }, { type: 'text', text: '<system-reminder>três</system-reminder>' }] },
  ]
  expect(reminderBlocks(messages)).toEqual(['um', 'dois', 'três'])
})
