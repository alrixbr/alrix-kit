import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, PromptChangeInput, PromptChangeResult, PromptOrigin } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import type { Turn } from './core'
import {
  anchorOf,
  cleanReply,
  conversationOf,
  fixEmphasis,
  inputFor,
  judge,
  keptShare,
  ownerText,
  protectedTokens,
  rejectReason,
  shouldRefine,
  splitGaps,
} from './core'
import { reasonKind } from './usage'

const USAGE = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }
const OWNER: PromptOrigin = { kind: 'composer' }
const LONG = 'preciso q vc arrume o bug do login no celular ele fica carregando e nao entra'
const ORGANIZED = 'Preciso que você arrume o bug do login no celular: ele fica carregando e não entra.'
const ENGINEERED = 'Arrume o bug do login no celular. Hoje ele fica carregando e não entra; quero que entre.'
const OTHER = 'agora quero que voce olhe o deploy da loja e veja os logs do nginx de ontem'
/** Uma mensagem longa (400 caracteres ou mais), a única que o Engenharia da sessão para para a revisão. */
const DETAIL = ' tambem quero que voce confira o cadastro, o fluxo de recuperar senha e a tela de boas vindas antes de fechar, e me diga o que mudou em cada um.'
const BIG = `${LONG}.${DETAIL.repeat(3)}`
const BIG_ENGINEERED = `${ENGINEERED}${DETAIL.repeat(3)}`
const USE_FILE = 'C:/Users/dono/.claude/alrix-prompt/uso/sessao-1.jsonl'
/** A resposta do Engenharia com o bloco de lacunas no fim: três linhas, das quais só duas valem. */
const GAPPED = `${ENGINEERED}\n\n<lacunas>\n- em qual celular: Android ou iPhone\n- o que conta como entrar\n- uma terceira que não cabe\n</lacunas>`

type Given = {
  reply?: ModelCompleteResult | ((prompt: string) => ModelCompleteResult)
  isFilled?: boolean
  doesFillFail?: boolean
  store?: Record<string, unknown>
  held?: Promise<void>
  env?: Record<string, string>
  doesWriteFail?: boolean
}
type Seen = { clock: MockClock }

const answered = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** Resolve quando o sinal dispara: o modelo de mentira para no meio, como o de verdade. */
const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })))

/**
 * O motor sob o mod: o modelo responde `given.reply` (depois de `given.held`, quando há), a caixa guarda o que o mod
 * põe nela e o que o dono digita (`typing`), e o que entra na sessão fica anotado. O relógio começa longe do zero.
 */
function engine(on: On, given: Given = {}) {
  const asked: ModelCompleteInput[] = []
  const entered: { text: string; context?: readonly string[] }[] = []
  const filled: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const commands: string[] = []
  const statuses: number[] = []
  /** O disco de mentira: o registro de uso é o único arquivo que o mod escreve. */
  const written = new Map<string, string>()
  const env: Record<string, string> = { USERPROFILE: 'C:\\Users\\dono', ...given.env }
  let box = ''
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, given.store)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => (commands.push(e.name), { value: { command: e.name } }))
  on('fs.read', (_, e) => ({ value: written.get(e.path) ?? `PROMPT ${e.path.split(/[\\/]/).pop() ?? ''}` }))
  on('fs.exists', (_, e) => ({ value: written.has(e.path) }))
  on('fs.write', (_, e) => {
    if (given.doesWriteFail === true) throw new Error('disco cheio')
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'sessao-1' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'o login quebrou de novo', toolUses: [] }] }))
  on('session.cwd', () => ({ value: '/root/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('model.complete', async (_, e, next) => {
    asked.push(e)
    if (given.held !== undefined) await Promise.race([given.held, abortOf(next.signal)])
    if (next.signal.aborted) return { value: { isAnswered: false, reason: 'aborted', usage: NO_USAGE } }
    const reply = given.reply ?? answered(ORGANIZED)
    return { value: typeof reply === 'function' ? reply(e.prompt) : reply }
  })
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', (_, e) => {
    if (given.doesFillFail === true) throw new Error('a caixa não respondeu')
    filled.push(e.text)
    const isFilled = given.isFilled ?? true
    if (isFilled) box = e.text
    return { isFilled }
  })
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.submit', (_, e) => (entered.push({ text: e.text, context: e.context }), { text: e.text, context: e.context }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => (statuses.push(1), { value: undefined }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  // O que a engine desenha na faixa, abaixo da linha do mod.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const typing = (text: string): void => {
    box = text
  }
  return { asked, entered, filled, toasts, opened, commands, statuses, written, clock, typing }
}

/** A sessão aberta e passada a janela de abertura: daqui em diante é o dono digitando. */
async function open($: Engine, seen: Seen): Promise<void> {
  await $.session.start({ cwd: '/root/proj', surface: 'terminal', isInteractive: true })
  await seen.clock.advance(6_000)
}

const submit = ($: Engine, text: string, origin: PromptOrigin = OWNER) => $.prompt.submit({ text, origin, wait: false })
const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: OWNER, presentation: { isFullscreen: false, columns: 120 } })
const choose = ($: Engine, args: string) => run($, 'modo', args)
/** `/engenharia texto` digitado na caixa: chega ao prompt.submit como comando, antes de o comando rodar. */
const oneShot = ($: Engine, name: 'organizar' | 'engenharia', args: string) =>
  $.prompt.submit({ text: `/${name} ${args}`, origin: OWNER, wait: false, command: { name, args } })

type RaisesChange = { change: (e: PromptChangeInput) => Promise<PromptChangeResult> }
/** `prompt.change` só se observa e não está tipado no `$.prompt` do teste; o kit o dispara como qualquer evento. */
const boxChanged = ($: Engine, text: string) =>
  ($.prompt as unknown as RaisesChange).change({ text, cursor: text.length, origin: { kind: 'engine' } })

const BAND = {
  plugin: 'alrix-prompt',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'alrix-prompt',
  component: 'Pane',
  requestId: 'alrix-prompt',
  props: { title: 'alrix-prompt · original e reescrita', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

function holding() {
  let release = (): void => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  return { held, release: () => release() }
}

test('toda sessão começa em Normal, mesmo com um modo de uma versão antiga guardado, e passa a mensagem intacta', async ($, on) => {
  const seen = engine(on, { store: { mode: 'engenharia' } })
  await open($, seen)
  expect(seen.commands).toEqual(['modo', 'organizar', 'engenharia'])
  await submit($, LONG)
  await submit($, `${LONG} @app/Views/Composer.cs /review`)
  expect(seen.asked).toHaveLength(0)
  expect(seen.entered).toEqual([
    { text: LONG, context: undefined },
    { text: `${LONG} @app/Views/Composer.cs /review`, context: undefined },
  ])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /só a próxima/ }))?.text).toBe('ctrl+x tab e 2 ou 3: só a próxima · de novo: na sessão')
  await ui.unmount()
})

test('/modo 2 liga o Organizar na sessão: o Sonnet 5.5 arruma o texto e ele segue, sem âncora, até trocar', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  expect(await choose($, '2')).toEqual({})
  expect(seen.toasts[0]).toContain('Modo Organizar nesta sessão')
  await submit($, LONG)
  await submit($, LONG)
  expect(seen.asked).toHaveLength(2)
  expect(seen.asked[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 4_096, system: 'PROMPT organizar.md' })
  expect(seen.asked[0]?.prompt).toBe(`<mensagem>\n${LONG}\n</mensagem>`)
  expect(seen.entered).toEqual([
    { text: ORGANIZED, context: undefined },
    { text: ORGANIZED, context: undefined },
  ])
})

test('/modo sozinho vai para o próximo, e um argumento desconhecido explica o uso', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  await choose($, '')
  await choose($, '')
  expect(seen.toasts).toEqual([expect.stringContaining('Modo Organizar'), expect.stringContaining('Modo Engenharia')])
  expect(await choose($, 'turbo')).toMatchObject({ text: expect.stringContaining('Use /modo 1, 2 ou 3') })
  await choose($, 'normal')
  await submit($, LONG)
  expect(seen.asked).toHaveLength(0)
})

test('/organizar vale só para a próxima mensagem; depois volta o Normal', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  expect(await run($, 'organizar')).toEqual({})
  expect(seen.toasts[0]).toContain('Organizar só na próxima mensagem')
  // Curta demais para valer a chamada: passa, e o modo continua armado para a mensagem de verdade.
  await submit($, 'sim')
  await submit($, LONG)
  await submit($, LONG)
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered.map(one => one.text)).toEqual(['sim', ORGANIZED, LONG])
})

test('na faixa, o primeiro toque vale só para a próxima, o segundo mantém na sessão e o terceiro desliga', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'alrix-prompt-organizar' })
  expect((await ui.find({ type: 'Text', text: /só na próxima/ }))?.text).toBe('Organizar só na próxima mensagem · 2 de novo mantém na sessão')
  await ui.press({ key: 'alrix-prompt-organizar' })
  expect((await ui.find({ type: 'Text', text: /nesta sessão/ }))?.text).toBe('Organizar nesta sessão')
  await ui.press({ key: 'alrix-prompt-organizar' })
  expect(await ui.find({ type: 'Text', text: /nesta sessão/ })).toBeUndefined()
  expect(seen.toasts.at(-1)).toContain('Modo Normal')
  // Na sessão em Engenharia, Normal só na próxima: ela vai como foi digitada e o Engenharia volta.
  await ui.press({ key: 'alrix-prompt-engenharia' })
  await ui.press({ key: 'alrix-prompt-engenharia' })
  expect((await ui.find({ type: 'Text', text: /nesta sessão/ }))?.text).toBe('Engenharia nesta sessão · só nas mensagens longas')
  await ui.press({ key: 'alrix-prompt-normal' })
  await ui.unmount()
  await submit($, BIG)
  expect(seen.asked).toHaveLength(0)
  expect(seen.entered).toEqual([{ text: BIG, context: undefined }])
})

test('com o Engenharia na sessão, só a mensagem longa para para a revisão; /engenharia leva a próxima curta', async ($, on) => {
  const seen = engine(on, { reply: prompt => answered(prompt.includes(DETAIL) ? BIG_ENGINEERED : ENGINEERED) })
  await open($, seen)
  await choose($, '3')
  expect(seen.toasts[0]).toContain('as mensagens longas (400 caracteres ou mais)')
  // A curta vai como ele digitou, sem chamada.
  await submit($, LONG)
  expect(seen.asked).toHaveLength(0)
  expect(seen.entered).toEqual([{ text: LONG, context: undefined }])
  // A longa para para a revisão, e segue com a âncora.
  expect(await submit($, BIG)).toMatchObject({ drop: expect.stringContaining('Revise e aperte Enter') })
  expect(seen.filled).toEqual([BIG_ENGINEERED])
  await submit($, BIG_ENGINEERED)
  expect(seen.entered.at(-1)).toEqual({ text: BIG_ENGINEERED, context: [anchorOf(BIG, true)] })
  // O que ele colou não conta para o tamanho: curta com um bloco grande colado também vai direto.
  const pasted = `olha esse log e me fala o que ta errado nele\n<pasted_content id="c1">\n${'linha do log\n'.repeat(60)}</pasted_content id="c1">`
  await submit($, pasted)
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered.at(-1)).toEqual({ text: pasted, context: undefined })
  // /engenharia com a sessão já em Engenharia: a próxima passa pela revisão mesmo curta, e só ela.
  seen.typing('')
  await run($, 'engenharia')
  expect(seen.toasts.at(-1)).toContain('mesmo curta')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /mesmo curta/ }))?.text).toBe('Engenharia na próxima mensagem, mesmo curta')
  await ui.unmount()
  expect(await submit($, LONG)).toMatchObject({ drop: expect.stringContaining('Revise e aperte Enter') })
  await submit($, ENGINEERED)
  expect(seen.entered.at(-1)).toEqual({ text: ENGINEERED, context: [anchorOf(LONG, true)] })
  await submit($, OTHER)
  expect(seen.asked).toHaveLength(2)
  expect(seen.entered.at(-1)).toEqual({ text: OTHER, context: undefined })
})

test('a faixa liga o modo também no desktop', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'alrix-prompt-organizar' })
  await ui.unmount()
  await submit($, LONG)
  expect(seen.entered[0]?.text).toBe(ORGANIZED)
})

test('o Engenharia devolve na caixa, a caixa fica só com a reescrita, e a revisão segue com a âncora', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  expect(await submit($, LONG)).toMatchObject({ drop: expect.stringContaining('Revise e aperte Enter') })
  expect(seen.filled).toEqual([ENGINEERED])
  expect(seen.entered).toHaveLength(0)
  expect(seen.asked[0]).toMatchObject({ effort: 'medium', maxTokens: 16_000, system: 'PROMPT engenharia.md' })
  expect(seen.asked[0]?.prompt).toContain('<alvo>Claude Code (modelo Claude), claude-opus-5-5</alvo>')
  expect(seen.asked[0]?.prompt).toContain('<projeto>/root/proj</projeto>')
  expect(seen.asked[0]?.prompt).toContain('[dono] o login quebrou de novo')

  // A engine devolve a original do envio descartado ao fim da caixa: ela sai, o resto fica, e só uma vez.
  await boxChanged($, `${ENGINEERED} Sem pressa.\n\n${LONG}`)
  await boxChanged($, `${ENGINEERED} Sem pressa.\n\n${LONG}`)
  expect(seen.filled).toEqual([ENGINEERED, `${ENGINEERED} Sem pressa.`])

  await submit($, `${ENGINEERED} Sem reiniciar nada.`)
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered).toEqual([{ text: `${ENGINEERED} Sem reiniciar nada.`, context: [anchorOf(LONG, true)] }])
  expect(anchorOf(LONG, true)).toContain('vale o que ele mandou')
})

test('/engenharia só para uma mensagem: a reestruturada vai para a revisão e o modo volta ao Normal', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  expect(seen.filled).toEqual([ENGINEERED])
  await submit($, ENGINEERED)
  expect(seen.entered).toEqual([{ text: ENGINEERED, context: [anchorOf(LONG, true)] }])
  await submit($, OTHER)
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered.at(-1)).toEqual({ text: OTHER, context: undefined })
})

test('/engenharia com o texto depois: só aquele texto é reestruturado, e ele volta para a caixa sem nada ir', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  expect(await oneShot($, 'engenharia', LONG)).toMatchObject({ drop: expect.stringContaining('Revise e aperte Enter') })
  expect(seen.asked[0]?.prompt).toContain(`<mensagem>\n${LONG}\n</mensagem>`)
  expect(seen.filled).toEqual([ENGINEERED])
  expect(seen.entered).toHaveLength(0)
  await boxChanged($, `${ENGINEERED}/engenharia ${LONG}`)
  expect(seen.filled).toEqual([ENGINEERED, ENGINEERED])
  await submit($, ENGINEERED)
  expect(seen.entered).toEqual([{ text: ENGINEERED, context: [anchorOf(LONG, true)] }])
})

test('/organizar com o texto depois também volta para a caixa, e a revisão vai sem âncora', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  expect(await oneShot($, 'organizar', LONG)).toMatchObject({ drop: expect.stringContaining('Confira e aperte Enter') })
  expect(seen.filled).toEqual([ORGANIZED])
  await submit($, ORGANIZED)
  expect(seen.entered).toEqual([{ text: ORGANIZED, context: undefined }])
})

test('/engenharia texto com a reescrita barrada devolve o texto dele à caixa, sem o comando', async ($, on) => {
  const seen = engine(on, { reply: answered('Ok.') })
  await open($, seen)
  expect(await oneShot($, 'engenharia', LONG)).toMatchObject({ drop: expect.stringContaining('reescrita descartada (encurtou demais)') })
  expect(seen.filled).toEqual([LONG])
  await submit($, LONG)
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered).toEqual([{ text: LONG, context: undefined }])
})

test('a reescrita cortada pelo dono ainda é a revisão, e a âncora diz que vale o que ele mandou', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  await submit($, 'Arrume o bug do login no celular.')
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered).toEqual([{ text: 'Arrume o bug do login no celular.', context: [anchorOf(LONG, true)] }])
})

test('um "ok" no lugar da reescrita vai como veio, sem a âncora dela', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  await submit($, 'ok')
  expect(seen.entered).toEqual([{ text: 'ok', context: undefined }])
})

test('um pedido novo no lugar da reescrita é reestruturado de novo, sem a âncora da anterior', async ($, on) => {
  const NEW = 'Olhe o deploy da loja e veja os logs do nginx de ontem.'
  const seen = engine(on, { reply: prompt => answered(prompt.includes(OTHER) ? NEW : ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  seen.typing('')
  await run($, 'engenharia')
  expect(await submit($, OTHER)).toMatchObject({ drop: expect.stringContaining('Revise e aperte Enter') })
  expect(seen.asked).toHaveLength(2)
  expect(seen.asked[1]?.prompt).toContain(OTHER)
  expect(seen.filled.at(-1)).toBe(NEW)
  expect(seen.entered).toHaveLength(0)
})

test('o que o dono começou a digitar durante a espera fica na caixa, e a reescrita vai direto com a âncora', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  seen.typing('e depois veja o cache')
  await submit($, LONG)
  expect(seen.filled).toHaveLength(0)
  expect(seen.entered).toEqual([{ text: ENGINEERED, context: [anchorOf(LONG, false)] }])
  expect(seen.toasts[1]).toContain('você já escrevia outra mensagem')
})

test('na revisão, "usar a original" troca a caixa e guarda a reescrita editada; a original vai sem âncora', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  seen.typing(`${ENGINEERED} Sem pressa.`)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /revise a versão/ }))?.text).toContain('aperte Enter')
  await ui.press({ key: 'alrix-prompt-swap' })
  expect((await ui.find({ type: 'Text', text: /original está na caixa/ }))?.text).toContain('Enter manda como está')
  await ui.press({ key: 'alrix-prompt-swap' })
  await ui.press({ key: 'alrix-prompt-swap' })
  expect(seen.filled).toEqual([ENGINEERED, LONG, `${ENGINEERED} Sem pressa.`, LONG])
  await ui.unmount()

  await boxChanged($, `${LONG}${LONG}`)
  expect(seen.filled).toHaveLength(4)
  await submit($, LONG)
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered).toEqual([{ text: LONG, context: undefined }])
})

test('pelo Remote Control, ou sem caixa, o Engenharia manda direto com a âncora', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED), isFilled: false })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG, { kind: 'bridge' })
  await run($, 'engenharia')
  await submit($, LONG)
  expect(seen.filled).toEqual([ENGINEERED])
  expect(seen.entered).toEqual([
    { text: ENGINEERED, context: [anchorOf(LONG, false)] },
    { text: ENGINEERED, context: [anchorOf(LONG, false)] },
  ])
})

test('se a caixa falha, vai a original uma vez só e nada fica esperando revisão', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED), doesFillFail: true })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  expect(seen.entered).toEqual([{ text: LONG, context: undefined }])
  expect(seen.toasts[1]).toContain('a caixa não respondeu')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /revise a versão/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /descartada/ }))?.text).toContain('a caixa não respondeu')
  await ui.unmount()
})

test('mensagem nova durante a espera volta para a caixa, para não passar à frente', async ($, on) => {
  const { held, release } = holding()
  const seen = engine(on, { held })
  await open($, seen)
  await choose($, '2')
  const first = submit($, LONG)
  await seen.clock.settle()
  expect(await submit($, 'e o cadastro também')).toMatchObject({ drop: expect.stringContaining('voltou para a caixa') })
  release()
  await first
  expect(seen.entered).toEqual([{ text: ORGANIZED, context: undefined }])
})

test('"cancelar" na faixa para o especialista: nada vai, e a mensagem volta para a caixa', async ($, on) => {
  const { held, release } = holding()
  const seen = engine(on, { held })
  await open($, seen)
  await choose($, '2')
  const sent = submit($, LONG)
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'alrix-prompt-cancel' })
  expect(await sent).toMatchObject({ drop: expect.stringContaining('cancelado: nada foi enviado') })
  release()
  expect(seen.entered).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /cancelada/ }))?.text).toBe('· cancelada: nada foi enviado')
  expect(await ui.find({ key: 'alrix-prompt-cancel' })).toBeUndefined()
  await ui.unmount()
  // A próxima segue normalmente.
  await submit($, LONG)
  expect(seen.entered).toEqual([{ text: ORGANIZED, context: undefined }])
})

test('mensagem de outra sessão, comando, modo bash e mensagem curta passam como vieram', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  await choose($, '2')
  await submit($, LONG, { kind: 'peer' })
  await $.prompt.submit({ text: LONG, origin: OWNER, wait: false, command: { name: 'review', args: LONG } })
  await submit($, '!ls -la /root/projeto/uma/pasta/bem/longa/de/verdade')
  await submit($, 'sim, pode commitar')
  expect(seen.asked).toHaveLength(0)
  expect(seen.entered.map(one => one.text)).toEqual([
    LONG,
    LONG,
    '!ls -la /root/projeto/uma/pasta/bem/longa/de/verdade',
    'sim, pode commitar',
  ])
})

test('o prompt que abre a sessão passa como veio', async ($, on) => {
  const seen = engine(on)
  // O argumento do CLI pode chegar antes do `session.start`, ou logo depois.
  await submit($, LONG)
  await $.session.start({ cwd: '/root/proj', surface: 'terminal', isInteractive: true })
  await choose($, '2')
  await submit($, LONG)
  await seen.clock.advance(6_000)
  await submit($, LONG)
  expect(seen.asked).toHaveLength(1)
  expect(seen.entered.map(one => one.text)).toEqual([LONG, LONG, ORGANIZED])
})

test('/clear volta ao Normal, como numa sessão nova', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  await choose($, '3')
  // Depois de um /clear não há session.start: a conversa recomeça no mesmo processo.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await submit($, BIG)
  expect(seen.asked).toHaveLength(0)
  expect(seen.entered).toEqual([{ text: BIG, context: undefined }])
})

test('erro da API manda a original, avisa e deixa o aviso na faixa', async ($, on) => {
  const failed: ModelCompleteResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
  const seen = engine(on, { reply: failed })
  await open($, seen)
  await choose($, '2')
  await submit($, LONG)
  expect(seen.entered).toEqual([{ text: LONG, context: undefined }])
  expect(seen.toasts[1]).toContain('erro da API 529 overloaded')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /descartada/ }))?.text).toBe(
    '⚠ reescrita descartada (erro da API 529 overloaded) · foi a sua original',
  )
  await ui.unmount()
})

test('o Organizar que perde um caminho é descartado, e a original vai', async ($, on) => {
  const seen = engine(on, { reply: answered('Roda o typecheck no projeto e corrige os erros que aparecerem, por favor.') })
  await open($, seen)
  await choose($, '2')
  const typed = 'roda o typecheck no /root/site e corrige os erros que aparecerem por favor'
  await submit($, typed)
  expect(seen.entered).toEqual([{ text: typed, context: undefined }])
  expect(seen.toasts[1]).toContain('perdeu /root/site')
})

test('o Engenharia que inventa um comando é descartado', async ($, on) => {
  const seen = engine(on, { reply: answered(`${ENGINEERED} Rode \`npm run typecheck\` em src/app.ts para conferir.`) })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  expect(seen.filled).toHaveLength(0)
  expect(seen.entered).toEqual([{ text: LONG, context: undefined }])
  expect(seen.toasts[1]).toContain('inventou')
})

test('a faixa mostra o custo da última reescrita e abre a comparação', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  await choose($, '2')
  await submit($, LONG)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /organizada/ }))?.text).toBe('✓ organizada · 0,0 s · 1,2 mil → 120 tokens')
  await ui.press({ key: 'alrix-prompt-compare' })
  expect(seen.opened).toEqual(['alrix-prompt'])
  await ui.unmount()
})

test('enquanto o Sonnet trabalha, a faixa conta os segundos', async ($, on) => {
  const { held, release } = holding()
  const seen = engine(on, { held })
  await open($, seen)
  await choose($, '2')
  const sent = submit($, LONG)
  await seen.clock.settle()
  await seen.clock.advance(2_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /organizando/ }))?.text).toBe('◐ organizando com o Sonnet 5.5 · 2 s')
  release()
  await sent
  // Só a faixa avisa: nenhuma linha de status a mais durante a espera.
  expect(seen.statuses).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /organizada/ }))?.text).toContain('✓ organizada · 2,0 s')
  await ui.unmount()
})

test('o painel compara o que o dono digitou com o que foi para o agente', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await empty.find({ type: 'Text' }))?.text).toBe('Nenhuma reescrita nesta sessão ainda.')
  await empty.unmount()
  await choose($, '2')
  await submit($, LONG)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: LONG })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Foi para o agente/ }))?.text).toBe('Foi para o agente')
  expect(await ui.find({ type: 'Text', text: ORGANIZED })).toBeDefined()
  await ui.unmount()
})

const PASTED = '<pasted_content id="b6fe">\nlinha um do rodape\nlinha dois: nao mexa aqui\n</pasted_content id="b6fe">'
const WITH_PASTE = `organizem melhor isso aqui\n\n${PASTED}\n\ne usem o que for recomendado pro nosso projeto`
const BARE = 'organizem melhor isso aqui\n\n[[COLADO-1]]\n\ne usem o que for recomendado pro nosso projeto'

test('um bloco colado não passa pelo especialista: vai um marcador, e o bloco volta inteiro, com as tags', async ($, on) => {
  const seen = engine(on, { reply: answered('Organizem melhor isso aqui:\n\n[[COLADO-1]]\n\nE usem o que for recomendado pro nosso projeto.') })
  await open($, seen)
  await choose($, '2')
  await submit($, WITH_PASTE)
  expect(seen.asked[0]?.prompt).toBe(`<mensagem>\n${BARE}\n</mensagem>`)
  expect(seen.entered).toEqual([{ text: `Organizem melhor isso aqui:\n\n${PASTED}\n\nE usem o que for recomendado pro nosso projeto.`, context: undefined }])
})

test('a reescrita que perde, repete ou copia o bloco colado é descartada, e a original vai', async ($, on) => {
  const replies = [
    'Organizem melhor isso aqui e usem o que for recomendado pro nosso projeto.',
    'Organizem melhor isso aqui:\n\n[[COLADO-1]]\n\n[[COLADO-1]]\n\nE usem o que for recomendado pro nosso projeto.',
    `Organizem melhor isso aqui:\n\n${PASTED}\n\nE usem o que for recomendado pro nosso projeto.`,
  ]
  const seen = engine(on, { reply: () => answered(replies.shift() ?? '') })
  await open($, seen)
  await choose($, '2')
  await submit($, WITH_PASTE)
  await submit($, WITH_PASTE)
  await submit($, WITH_PASTE)
  expect(seen.entered.map(one => one.text)).toEqual([WITH_PASTE, WITH_PASTE, WITH_PASTE])
  expect(seen.toasts.slice(1)).toEqual([
    expect.stringContaining('mexeu num trecho colado'),
    expect.stringContaining('mexeu num trecho colado'),
    expect.stringContaining('mexeu num trecho colado'),
  ])
})

test('quando o que ele digitou é curto e o resto é colado, a mensagem passa como veio', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  await choose($, '2')
  await submit($, `olha isso\n${PASTED}`)
  expect(seen.asked).toHaveLength(0)
  expect(seen.entered).toEqual([{ text: `olha isso\n${PASTED}`, context: undefined }])
})

test('o Engenharia com imagem vai direto, com a âncora, e nada fica na caixa', async ($, on) => {
  const seen = engine(on, { reply: answered(ENGINEERED) })
  await open($, seen)
  await run($, 'engenharia')
  await $.prompt.submit({ text: LONG, origin: OWNER, wait: false, attachments: [{ type: 'image', mediaType: 'image/png' }] })
  expect(seen.filled).toHaveLength(0)
  expect(seen.entered).toEqual([{ text: ENGINEERED, context: [anchorOf(LONG, false)] }])
  expect(seen.toasts[1]).toContain('a mensagem tem imagem')
  // A seguinte, sem imagem, volta para a revisão na caixa.
  await run($, 'engenharia')
  expect(await submit($, LONG)).toMatchObject({ drop: expect.stringContaining('Revise e aperte Enter') })
})

test('cada mensagem tratada deixa uma linha no registro de uso, sem o texto dela', async ($, on) => {
  const seen = engine(on)
  await open($, seen)
  await choose($, '2')
  const typed = 'roda o typecheck no /root/site e corrige os erros que aparecerem por favor'
  await submit($, LONG)
  await submit($, typed)
  // O motor entrega o caminho no formato do sistema: no Windows, com barras invertidas.
  const [path = '', file = ''] = [...seen.written.entries()][0] ?? []
  expect(seen.written.size).toBe(1)
  expect(path.replace(/\\/g, '/')).toBe(USE_FILE)
  const at = new Date(1_006_000).toISOString()
  expect(file.trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([
    { em: at, modo: 'organizar', resultado: 'enviada', ms: 0, tokensIn: 1_200, tokensOut: 120, original: LONG.length, reescrita: ORGANIZED.length },
    { em: at, modo: 'organizar', resultado: 'descartada', motivo: 'perdeu um item técnico', ms: 0, tokensIn: 1_200, tokensOut: 120, original: typed.length },
  ])
  // Nem o texto dele nem o pedaço que o aviso na tela mostra vão para o arquivo.
  expect(file).not.toContain('login')
  expect(file).not.toContain('/root/site')
  expect(reasonKind('perdeu a ênfase de TOP')).toBe('perdeu a ênfase')
  expect(reasonKind('inventou src/app.ts')).toBe('inventou')
  expect(reasonKind('erro da API 529 overloaded')).toBe('erro da API 529')
  expect(reasonKind('se afastou do pedido')).toBe('se afastou do pedido')
})

test('ALRIX_PROMPT_REGISTRO=0 desliga o registro', async ($, on) => {
  const off = engine(on, { env: { ALRIX_PROMPT_REGISTRO: '0' } })
  await open($, off)
  await choose($, '2')
  await submit($, LONG)
  expect(off.entered).toEqual([{ text: ORGANIZED, context: undefined }])
  expect(off.written.size).toBe(0)
})

test('se o registro de uso não consegue escrever, a mensagem segue igual', async ($, on) => {
  const seen = engine(on, { doesWriteFail: true })
  await open($, seen)
  await choose($, '2')
  await submit($, LONG)
  expect(seen.entered).toEqual([{ text: ORGANIZED, context: undefined }])
})

test('a conversa que o Engenharia lê: as últimas mensagens dele e a resposta a que cada uma reagiu', () => {
  const narration: Turn[] = Array.from({ length: 12 }, (_, index) => ({ role: 'assistant', text: `Vou ler o arquivo ${index}.` }))
  const report = `Pronto: ${'relato '.repeat(400)}fim do relato.`
  const recent: Turn[] = [
    { role: 'user', text: 'uma mensagem mais antiga ainda, que não cabe' },
    { role: 'assistant', text: 'a resposta a que a primeira reagiu' },
    { role: 'user', text: 'primeira mensagem que cabe' },
    { role: 'assistant', text: 'resposta antiga' },
    { role: 'user', text: 'arruma o login do celular' },
    ...narration,
    { role: 'assistant', text: 'Login arrumado em app/login.ts.' },
    { role: 'user', text: '<task-notification>\n<status>completed</status>\n</task-notification>' },
    { role: 'user', text: 'agora o cadastro\n<system-reminder>\nlembrete do motor\n</system-reminder>' },
    ...narration,
    { role: 'assistant', text: report },
  ]
  expect(conversationOf(recent)).toBe(
    [
      '[agente] a resposta a que a primeira reagiu',
      '[dono] primeira mensagem que cabe',
      '[agente] resposta antiga',
      '[dono] arruma o login do celular',
      '[agente] Login arrumado em app/login.ts.',
      '[dono] agora o cadastro',
      `[agente] ${report}`,
    ].join('\n\n'),
  )
  expect(conversationOf([])).toBe('')
  // Duas mensagens dele seguidas: a resposta mais próxima ainda vem quase inteira.
  expect(conversationOf([{ role: 'assistant', text: report }, { role: 'user', text: 'e o cadastro?' }, { role: 'user', text: 'pera, esquece' }])).toBe(
    [`[agente] ${report}`, '[dono] e o cadastro?', '[dono] pera, esquece'].join('\n\n'),
  )
  expect(ownerText(`Arrume o login.\n${anchorOf('arruma o login', true)}`)).toBe('Arrume o login.')
  expect(ownerText('This session is being continued from a previous conversation')).toBe('')
  expect(ownerText(`veja isso ${PASTED}`)).toBe('veja isso (bloco colado, 44 caracteres)')
})

test('o Engenharia lê o começo do que foi colado, devolve o marcador e o bloco volta inteiro', () => {
  const input = { text: WITH_PASTE, harness: 'claude' as const, cwd: '/root/proj', recent: [] }
  const asked = inputFor('engenharia', input)
  expect(asked).toContain('<colados>\n[[COLADO-1]] (44 caracteres)\nlinha um do rodape\nlinha dois: nao mexa aqui\n</colados>')
  expect(asked.endsWith(`<mensagem>\n${BARE}\n</mensagem>`)).toBe(true)
  expect(judge('engenharia', input, 'Organizem melhor o bloco abaixo e usem o que for recomendado pro nosso projeto.\n\nO bloco:\n[[COLADO-1]]')).toEqual({
    text: `Organizem melhor o bloco abaixo e usem o que for recomendado pro nosso projeto.\n\nO bloco:\n${PASTED}`,
    gaps: [],
  })
  // Um caminho que só aparece no bloco colado não conta como inventado.
  const withPath = { ...input, text: `organizem melhor isso aqui e usem o que for recomendado\n\n<pasted_content id="a1">\nerro em src/app.ts\n</pasted_content id="a1">` }
  expect(judge('engenharia', withPath, 'Organizem melhor o erro abaixo, de src/app.ts, e usem o que for recomendado.\n\nO erro:\n[[COLADO-1]]')).toMatchObject({
    text: expect.stringContaining('erro em src/app.ts\n</pasted_content id="a1">'),
  })
  expect(shouldRefine('organizar', WITH_PASTE, false)).toBe(true)
  expect(shouldRefine('organizar', `olha isso\n${PASTED}`, false)).toBe(false)
})

test('as lacunas do Engenharia aparecem na faixa e no painel, e nunca vão para o agente', async ($, on) => {
  const seen = engine(on, { reply: answered(GAPPED) })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  // Na caixa entra só o pedido: o bloco das lacunas fica de fora.
  expect(seen.filled).toEqual([ENGINEERED])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /falta dizer/ }))?.text).toBe('falta dizer')
  expect(await ui.find({ type: 'Text', text: 'em qual celular: Android ou iPhone' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'o que conta como entrar' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /terceira/ })).toBeUndefined()
  // Com a original na caixa, as lacunas somem; de volta à reescrita, voltam.
  await ui.press({ key: 'alrix-prompt-swap' })
  expect(await ui.find({ type: 'Text', text: /falta dizer/ })).toBeUndefined()
  await ui.press({ key: 'alrix-prompt-swap' })
  expect(await ui.find({ type: 'Text', text: /falta dizer/ })).toBeDefined()
  await ui.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Falta dizer/ }))?.text).toBe('Falta dizer (só você vê; não foi para o agente)')
  expect(await pane.find({ type: 'Text', text: '· o que conta como entrar' })).toBeDefined()
  await pane.unmount()

  await submit($, ENGINEERED)
  expect(seen.entered).toEqual([{ text: ENGINEERED, context: [anchorOf(LONG, true)] }])
  expect(JSON.stringify(seen.entered)).not.toContain('celular: Android')
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /falt(a|ou) dizer/ })).toBeUndefined()
  await after.unmount()
  // No registro de uso fica só a contagem, na linha da chamada.
  const lines = ([...seen.written.values()][0] ?? '').trim().split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('"lacunas":2')
  expect(lines[0]).not.toContain('celular')
  expect(lines[1]).not.toContain('lacunas')
})

test('quando a reescrita vai direto, a faixa diz o que faltou dizer', async ($, on) => {
  const seen = engine(on, { reply: answered(GAPPED) })
  await open($, seen)
  await run($, 'engenharia')
  await $.prompt.submit({ text: LONG, origin: OWNER, wait: false, attachments: [{ type: 'image', mediaType: 'image/png' }] })
  expect(seen.entered).toEqual([{ text: ENGINEERED, context: [anchorOf(LONG, false)] }])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /faltou dizer/ }))?.text).toBe('faltou dizer')
  await ui.unmount()
})

test('ALRIX_PROMPT_LACUNAS=0 esconde as lacunas, e a reescrita segue igual', async ($, on) => {
  const seen = engine(on, { reply: answered(GAPPED), env: { ALRIX_PROMPT_LACUNAS: '0' } })
  await open($, seen)
  await run($, 'engenharia')
  await submit($, LONG)
  expect(seen.filled).toEqual([ENGINEERED])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /falta dizer/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /revise a versão/ }))?.text).toContain('aperte Enter')
  await ui.unmount()
})

test('as lacunas saem da resposta antes das travas', () => {
  expect(splitGaps('Texto.\n\n<lacunas>\n- uma\n2. duas\n* três\n</lacunas>')).toEqual({ text: 'Texto.', gaps: ['uma', 'duas'] })
  expect(splitGaps('Texto.\n\n```\n<lacunas>\n- uma\n</lacunas>\n```')).toEqual({ text: 'Texto.', gaps: ['uma'] })
  expect(splitGaps('Texto.\n<lacunas>\nnenhuma\n</lacunas>')).toEqual({ text: 'Texto.', gaps: [] })
  expect(splitGaps('Texto sem bloco.')).toEqual({ text: 'Texto sem bloco.', gaps: [] })
  expect(splitGaps(`Texto.\n<lacunas>\n- ${'x'.repeat(120)}\n</lacunas>`).gaps[0]).toHaveLength(90)
  const input = { text: LONG, harness: 'claude' as const, cwd: '/root/proj', recent: [] }
  // O bloco depois da tag de saída, ou dentro dela.
  expect(judge('engenharia', input, `<saida>${ENGINEERED}</saida>\n<lacunas>\n- em qual celular\n</lacunas>`)).toEqual({ text: ENGINEERED, gaps: ['em qual celular'] })
  expect(judge('engenharia', input, `<saida>${ENGINEERED}\n\n<lacunas>\n- em qual celular\n</lacunas></saida>`)).toEqual({ text: ENGINEERED, gaps: ['em qual celular'] })
  expect(judge('organizar', input, ORGANIZED)).toEqual({ text: ORGANIZED, gaps: [] })
  // Só o bloco, sem o pedido: a reescrita é descartada.
  expect(judge('engenharia', input, '<lacunas>\n- em qual celular\n</lacunas>')).toEqual({ reason: 'veio vazia' })
})

test('a ênfase da reescrita é acertada pela do dono antes das travas', () => {
  // O grito que o especialista pôs volta a minúsculas, com a inicial maiúscula no começo da frase.
  expect(fixEmphasis('ve o log e nao troca de conta nem de plano', 'Veja o log. Só investigue: não altere arquivos e NÃO troque de conta nem de plano.')).toBe(
    'Veja o log. Só investigue: não altere arquivos e não troque de conta nem de plano.',
  )
  expect(fixEmphasis('conserta mas sem mudar a duração', 'Corrija os erros. NÃO mude a duração.\n- SEM pressa')).toBe('Corrija os erros. Não mude a duração.\n- Sem pressa')
  // O grito dele que virou minúscula, numa palavra que aparece uma vez só, volta.
  expect(fixEmphasis('implementa e NAO usa nenhuma lib nova', 'Implemente. Não use nenhuma lib nova.')).toBe('Implemente. NÃO use nenhuma lib nova.')
  // Duas ocorrências: não dá para saber qual é a dele, e a trava decide.
  const twice = 'Não altere arquivos e não use lib nova.'
  expect(fixEmphasis('NAO usa lib nova', twice)).toBe(twice)
  expect(rejectReason('engenharia', 'NAO usa lib nova no projeto', twice)).toBe('perdeu a ênfase de NAO')
  // Pedaço de caminho ou de nome de arquivo não muda.
  expect(fixEmphasis('olha a API nova de contas', 'Veja o endpoint em /api/contas e o api.ts.')).toBe('Veja o endpoint em /api/contas e o api.ts.')
  // A ênfase que já é a dele fica como está, e o marcador do que foi colado também.
  expect(fixEmphasis('NAO apaga isso [[COLADO-1]]', 'NÃO apague o bloco abaixo.\n[[COLADO-1]]')).toBe('NÃO apague o bloco abaixo.\n[[COLADO-1]]')
  const input = { text: 'pq o codex ta dando erro? ve o log e me fala, nao troca de conta nem de plano', harness: 'codex' as const, cwd: '/root/proj', recent: [] }
  expect(judge('engenharia', input, 'Investigue por que o Codex está dando erro. Veja o log e me diga a causa. NÃO troque de conta nem de plano.')).toEqual({
    text: 'Investigue por que o Codex está dando erro. Veja o log e me diga a causa. Não troque de conta nem de plano.',
    gaps: [],
  })
})

test('as travas de fidelidade', () => {
  expect(rejectReason('organizar', 'olha a [Image #1] e me fala o que ta errado nessa tela aqui', 'Olha a imagem e me fala o que tá errado nessa tela aqui.')).toBe(
    'perdeu [Image #1]',
  )
  expect(rejectReason('organizar', 'olha a [Image #1] e me fala o que ta errado nessa tela aqui', 'Olha a [Image #1] e me fala o que tá errado nessa tela aqui.')).toBeUndefined()
  expect(protectedTokens('veja /root/alrix. e `npm run check` em https://x.dev/a, e/ou 24/7 e /plugin-dev:agent-development')).toEqual([
    'https://x.dev/a',
    '/root/alrix',
    '/plugin-dev:agent-development',
    'npm run check',
  ])
  expect(protectedTokens('abre @app/Views/Composer.cs e C:\\Users\\ana\\x e engine/src/refine.ts e ALRIX_CODE_IDLE_MS')).toEqual([
    'C:\\Users\\ana\\x',
    '@app/Views/Composer.cs',
    'ALRIX_CODE_IDLE_MS',
    'engine/src/refine.ts',
  ])
  expect(rejectReason('organizar', LONG, 'Ok.')).toBe('encurtou demais')
  expect(rejectReason('organizar', LONG, ORGANIZED)).toBeUndefined()
  const kept = 'nao apague os arquivos de log da pasta antiga, so mova eles pra outra'
  expect(rejectReason('organizar', kept, 'Apague os arquivos de log da pasta antiga, só mova eles para outra.')).toBe('perdeu uma negação')
  expect(rejectReason('organizar', 'apague os 3 arquivos de log da pasta antiga agora', 'Apague os arquivos de log da pasta antiga agora.')).toBe('perdeu 3')
  expect(rejectReason('organizar', kept, 'Não apague os arquivos de log da pasta antiga; só mova eles para outra.')).toBeUndefined()
  expect(rejectReason('organizar', kept, 'Não remova os registros do diretório velho; apenas transfira eles para outro.')).toBe('trocou palavras')
  expect(rejectReason('organizar', 'quero isso SUPER rapido', 'Quero isso super rápido.')).toBe('perdeu a ênfase de SUPER')
  expect(rejectReason('engenharia', LONG, ENGINEERED)).toBeUndefined()
  // Quem responde é o dono, aprovando o que o agente perguntou: aí a reescrita pode abrir por "Sim,".
  expect(rejectReason('engenharia', 'pode sim! e depois vai no login, mas quero ele TOP', 'Sim, pode publicar. Depois, siga com o login; quero ele TOP.')).toBeUndefined()
  expect(rejectReason('engenharia', LONG, `Claro! ${ENGINEERED}`)).toBe('respondeu em vez de reescrever')
  expect(cleanReply('```\n<saida>texto</saida>\n```')).toBe('texto')
  expect(cleanReply('Compare os dois antes de decidir.</...>')).toBe('Compare os dois antes de decidir.')
  expect(cleanReply('O erro:\n<erro>\nTypeError: x\n</erro>')).toBe('O erro:\n<erro>\nTypeError: x\n</erro>')
  expect(rejectReason('organizar', 'olha o log e nao commita nada ok', 'Olha o log e NÃO commita nada, ok?')).toBe('pôs ênfase em NAO')
  expect(rejectReason('engenharia', 'gera em dist e copia pra pasta, nao pera, NAO copia, so gera', 'Gere o build em dist. NÃO copie para a pasta.')).toBeUndefined()
  expect(rejectReason('engenharia', 'quero o mod sem ficar ativo ate eu ligar ele aqui', 'Deixe o mod inativo até eu ligar ele aqui.')).toBeUndefined()
  expect(protectedTokens('O erro:\n<erro>\nx\n</erro> e o <texto_colado>')).toEqual([])
  expect(keptShare('pra mim tbm', 'Para mim também')).toBe(1)
  expect(keptShare('Arrume o bug do login no celular.', ENGINEERED)).toBe(1)
  expect(keptShare(OTHER, ENGINEERED)).toBeLessThan(0.5)
})
