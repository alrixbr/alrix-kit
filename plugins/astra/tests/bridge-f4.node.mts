// F4 na ponte, contra o App Server falso: o binding que retoma a thread numa ponte nova, a ferramenta longa que passa ao
// Claude Code, a entrada no meio do turno (`turn/steer`), o `/clear` (`thread/unsubscribe`) e a compactação.
// Roda com: node --test --experimental-strip-types --test-concurrency=1 <este arquivo>
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type AppServer, accountOf } from '../bridge/appserver.mts'
import { COMPACTION, THREAD_CONFIG } from '../bridge/ensure.mts'
import type { BridgeEvent } from '../bridge/proto.mts'
import { createThreads } from '../bridge/threads.mts'
import {
  asked, call, exited, HERE, IS_WINDOWS, type Json, MEMORY, modeOf, post, readUntil, startBridge, stateDir, texts, turn,
} from './fixtures/bridge-harness.mts'

const SESSION = `s${process.pid}`
const MAIN = `main:${SESSION}`
const HANDOFF = 'mcp_notas__buscar segue em execução no Claude Code. O resultado chega numa mensagem nova, depois que este turno terminar. Encerre o turno agora, sem chamar outra ferramenta.'
const toolCalls = (events: readonly BridgeEvent[]): string[] => events.flatMap(event => (event.kind === 'toolCall' ? [event.callId] : []))
const lastDone = (events: readonly BridgeEvent[]): BridgeEvent | undefined => events.findLast(event => event.kind === 'done')
const bindingOf = (name: string): Json => JSON.parse(readFileSync(join(stateDir(name), SESSION, `main_${SESSION}.json`), 'utf8')) as Json

async function stop(bridge: Awaited<ReturnType<typeof startBridge>>): Promise<void> {
  const gone = exited(bridge)
  await post(bridge, '/shutdown', {})
  await gone
}

test('binding: a thread fica gravada por loop, e a ponte nova a retoma pelo thread/resume, com o teto de contexto', async () => {
  const first = await startBridge('binding', {}, [], 'binding-1')
  await readUntil(first, MAIN, await turn(first, MAIN, 'ola', { session: SESSION }), 'done')
  const binding = bindingOf('binding')
  const account = accountOf({ email: 'fake@example.invalid', planType: 'pro' })
  assert.deepEqual({ ...binding, fingerprint: typeof binding.fingerprint, updatedAt: typeof binding.updatedAt }, { threadId: 'thr-1', cwd: HERE, model: 'gpt-6.1-sol', fingerprint: 'string', updatedAt: 'string', account })
  // No Windows o modo de arquivo não existe: a pasta de estado fica no perfil da pessoa, que só ela lê.
  if (!IS_WINDOWS) {
    assert.equal(modeOf(join(stateDir('binding'), SESSION, `main_${SESSION}.json`)), 0o600)
    assert.equal(modeOf(join(stateDir('binding'), SESSION)), 0o700)
  }
  assert.deepEqual(asked(first, 'thread/start')[0]?.config, { ...COMPACTION, ...THREAD_CONFIG })
  assert.deepEqual(COMPACTION, { model_auto_compact_token_limit: 400_000, model_context_window: 445_000 })
  await stop(first)
  const second = await startBridge('binding', {}, [], 'binding-2')
  const ensured = await post(second, '/threads/ensure', { key: MAIN, cwd: HERE, model: 'gpt-6-astra', session: SESSION, dynamicTools: [MEMORY] })
  assert.deepEqual(ensured, { threadId: 'thr-1', isNew: false })
  assert.equal(asked(second, 'thread/start').length, 0)
  const resume = asked(second, 'thread/resume')[0]
  assert.deepEqual({ ...resume, cwd: resume?.cwd === HERE }, {
    threadId: 'thr-1', model: 'gpt-6-astra', cwd: true, approvalPolicy: 'never', sandbox: 'workspace-write', developerInstructions: null, config: { ...COMPACTION, ...THREAD_CONFIG }, excludeTurns: true,
  })
  assert.equal(bindingOf('binding').model, 'gpt-6-astra')
  const { seq } = await post(second, '/turns', { key: MAIN, text: 'ola', model: 'gpt-6-astra' })
  assert.deepEqual(texts((await readUntil(second, MAIN, seq as number, 'done')).events), ['Oi'])
  await stop(second)
})

test('binding: instruções novas, outro cwd ou o resume recusado abrem uma thread nova, que passa a ser a do binding', async () => {
  const first = await startBridge('nova', {}, [], 'nova-1')
  await post(first, '/threads/ensure', { key: MAIN, cwd: HERE, model: 'gpt-6.1-sol', session: SESSION, dynamicTools: [MEMORY] })
  await stop(first)
  const changed = await startBridge('nova', {}, [], 'nova-2')
  const fresh = await post(changed, '/threads/ensure', { key: MAIN, cwd: HERE, model: 'gpt-6.1-sol', session: SESSION, developerInstructions: 'PAPEL', dynamicTools: [MEMORY] })
  assert.equal(fresh.isNew, true)
  assert.deepEqual([asked(changed, 'thread/resume').length, asked(changed, 'thread/start').length], [0, 1])
  const elsewhere = await post(changed, '/threads/ensure', { key: 'outro', cwd: '/tmp', model: 'gpt-6.1-sol', session: SESSION, dynamicTools: [] })
  assert.equal(elsewhere.isNew, true)
  await stop(changed)
  const refused = await startBridge('nova', { FAKE_RESUME_FAIL: '1' }, [], 'nova-3')
  const again = await post(refused, '/threads/ensure', { key: MAIN, cwd: HERE, model: 'gpt-6.1-sol', session: SESSION, developerInstructions: 'PAPEL', dynamicTools: [MEMORY] })
  assert.deepEqual([again.isNew, asked(refused, 'thread/resume').length, asked(refused, 'thread/start').length], [true, 1, 1])
  await stop(refused)
})

test('sem sessão no ensure, nada se grava', async () => {
  const bridge = await startBridge('sem-sessao')
  await post(bridge, '/threads/ensure', { key: 'k', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [] })
  assert.equal(existsSync(stateDir('sem-sessao')), false)
  await stop(bridge)
})

test('ferramenta longa: passado o hold, a ponte responde ela mesma, o turno fecha, e o resultado tardio é recusado', async () => {
  const bridge = await startBridge('hold', {}, ['--hold-ms', '300'])
  const started = performance.now()
  const { events, next } = await readUntil(bridge, 'k', await turn(bridge, 'k', 'ferramenta'), 'done')
  assert.ok(performance.now() - started >= 280, `fechou em ${Math.round(performance.now() - started)} ms`)
  assert.deepEqual(toolCalls(events), ['call-1'])
  assert.deepEqual(texts(events), [`Recebi: ${HANDOFF} (true)`])
  assert.deepEqual(lastDone(events), { seq: next, kind: 'done', status: 'completed' })
  assert.equal((await call(bridge, 'POST', '/tool-result', { key: 'k', callId: 'call-1', text: 'tarde', isError: false })).status, 409)
  await stop(bridge)
})

test('o resultado que chega antes do hold desarma o prazo: a ponte não responde de novo', async () => {
  const bridge = await startBridge('desarma', {}, ['--hold-ms', '400'])
  const first = await readUntil(bridge, 'k', await turn(bridge, 'k', 'ferramenta'), 'toolCall')
  await post(bridge, '/tool-result', { key: 'k', callId: 'call-1', text: 'nota', isError: false })
  const { events } = await readUntil(bridge, 'k', first.next, 'done')
  assert.deepEqual(texts(events), ['Recebi: nota (true)'])
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.deepEqual((await call(bridge, 'GET', `/events?key=k&after=${first.next}&waitMs=0`)).body.events, events)
  await stop(bridge)
})

test('/handoff passa a chamada na hora, e o /steer leva o resultado ao turno que ainda roda', async () => {
  const bridge = await startBridge('steer')
  const first = await readUntil(bridge, 'k', await turn(bridge, 'k', 'ouvir'), 'toolCall')
  assert.deepEqual(await post(bridge, '/handoff', { key: 'k', callId: 'call-1' }), { isHandedOff: true })
  assert.equal((await call(bridge, 'POST', '/handoff', { key: 'k', callId: 'call-1' })).status, 409)
  assert.deepEqual(await post(bridge, '/steer', { key: 'k', text: 'resultado tardio' }), { isSteered: true })
  const { events } = await readUntil(bridge, 'k', first.next, 'done')
  assert.deepEqual(texts(events), [`Recebi: ${HANDOFF} (true); ouvi: resultado tardio`])
  const steer = asked(bridge, 'turn/steer')[0]
  assert.deepEqual(steer, { threadId: 'thr-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'resultado tardio', text_elements: [] }] })
  const idle = await call(bridge, 'POST', '/steer', { key: 'k', text: 'sem turno' })
  assert.equal(idle.status, 409)
  assert.match(String(idle.body.error), /não há turno do Codex em curso/)
  await stop(bridge)
})

test('depois do repasse, chamada nova é recusada sem sair ao mod, e o turno que não fecha é interrompido em 10 s', async () => {
  const bridge = await startBridge('teima', {}, ['--hold-ms', '200'])
  const started = performance.now()
  const after = await turn(bridge, 'k', 'teima')
  const first = await readUntil(bridge, 'k', after, 'text')
  assert.deepEqual(toolCalls(first.events), ['call-1'])
  assert.deepEqual(texts(first.events), [`1: ${HANDOFF} (true); 2: Este turno já foi passado ao Claude Code. Encerre o turno agora, sem chamar outra ferramenta: o resultado chega numa mensagem nova. (false)`])
  const rest = await readUntil(bridge, 'k', first.next, 'done')
  const waited = performance.now() - started
  assert.deepEqual(lastDone(rest.events)?.kind === 'done' && lastDone(rest.events), { seq: rest.next, kind: 'done', status: 'interrupted' })
  assert.ok(waited >= 9_500 && waited < 13_000, `interrompido em ${Math.round(waited)} ms`)
  assert.equal(asked(bridge, 'turn/interrupt').length, 1)
  await stop(bridge)
})

/** Um turno com uma ferramenta retida, sobre um App Server que só anota os pedidos; os relógios do teste são falsos. */
async function heldTurn(): Promise<{ threads: ReturnType<typeof createThreads>; requests: string[]; responses: unknown[] }> {
  const requests: string[] = []
  const responses: unknown[] = []
  const server: AppServer = {
    request: async method => {
      requests.push(method)
      return method === 'thread/start' ? { thread: { id: 'thr-1' } } : method === 'turn/start' ? { turn: { id: 'turn-1' } } : {}
    },
    respond: (_id, result) => responses.push(result),
    refuse: () => undefined,
    close: async () => {},
    version: '0.169.0',
    isValidated: true,
    account: 'conta',
  }
  const threads = createThreads(async () => server, { holdMs: 1_000 })
  await threads.ensure({ key: 'k', cwd: '/x', model: 'gpt-6.1-sol', dynamicTools: [] })
  await threads.startTurn('k', 'oi', 'gpt-6.1-sol')
  threads.onRequest('rpc-1', 'item/tool/call', { threadId: 'thr-1', turnId: 'turn-1', callId: 'c1', tool: 'Bash', arguments: {} })
  return { threads, requests, responses }
}

test('threads: sem entrada depois do repasse, o turno é interrompido aos 10 s; com o /steer aceito, segue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const quiet = await heldTurn()
  t.mock.timers.tick(1_000)
  assert.deepEqual(quiet.responses, [{ contentItems: [{ type: 'inputText', text: HANDOFF.replace('mcp_notas__buscar', 'Bash') }], success: true }])
  t.mock.timers.tick(9_999)
  assert.equal(quiet.requests.includes('turn/interrupt'), false)
  t.mock.timers.tick(1)
  assert.equal(quiet.requests.includes('turn/interrupt'), true)
  const steered = await heldTurn()
  t.mock.timers.tick(1_000)
  assert.equal(await steered.threads.steer('k', 'o resultado'), true)
  t.mock.timers.tick(10_000)
  assert.deepEqual(steered.requests.filter(method => method.startsWith('turn/')), ['turn/start', 'turn/steer'])
  steered.threads.onRequest('rpc-2', 'item/tool/call', { threadId: 'thr-1', turnId: 'turn-1', callId: 'c2', tool: 'Bash', arguments: {} })
  assert.equal(steered.responses.length, 1, 'a chamada depois do steer fica retida, sem a recusa do repasse')
})

test('threads: o ensure que troca a thread do loop (outro cwd) deixa de ouvir a antiga', async () => {
  let opened = 0
  const server: AppServer = {
    request: async method => (method === 'thread/start' ? { thread: { id: `thr-${++opened}` } } : method === 'turn/start' ? { turn: { id: 'turn-1' } } : {}),
    respond: () => undefined,
    refuse: () => undefined,
    close: async () => {},
    version: '0.169.0',
    isValidated: true,
    account: 'conta',
  }
  const threads = createThreads(async () => server)
  await threads.ensure({ key: 'k', cwd: '/x', model: 'gpt-6.1-sol', dynamicTools: [] })
  assert.deepEqual(await threads.ensure({ key: 'k', cwd: '/y', model: 'gpt-6.1-sol', dynamicTools: [] }), { threadId: 'thr-2', isNew: true })
  await threads.startTurn('k', 'oi', 'gpt-6.1-sol')
  threads.onNotification('turn/completed', { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed', error: null } })
  assert.equal(threads.isBusy(), true, 'o fim de um turno da thread antiga fechou o turno da nova')
})

test('/forget solta as threads paradas da sessão; a que roda e a de outra sessão ficam, e o binding também', async () => {
  const bridge = await startBridge('forget')
  await post(bridge, '/threads/ensure', { key: MAIN, cwd: HERE, model: 'gpt-6.1-sol', session: SESSION, dynamicTools: [] })
  await turn(bridge, 'agente', 'espera', { session: SESSION })
  await post(bridge, '/threads/ensure', { key: 'main:outra', cwd: HERE, model: 'gpt-6.1-sol', session: 'outra', dynamicTools: [] })
  assert.deepEqual(await post(bridge, '/forget', { session: SESSION }), { forgotten: 1 })
  for (let round = 0; round < 20 && asked(bridge, 'thread/unsubscribe').length === 0; round += 1) await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(asked(bridge, 'thread/unsubscribe'), [{ threadId: 'thr-1' }])
  assert.equal((await call(bridge, 'GET', `/events?key=${encodeURIComponent(MAIN)}&after=0&waitMs=0`)).status, 404)
  assert.equal((await call(bridge, 'GET', '/events?key=agente&after=0&waitMs=0')).status, 200)
  assert.equal(bindingOf('forget').threadId, 'thr-1')
  const again = await post(bridge, '/threads/ensure', { key: MAIN, cwd: HERE, model: 'gpt-6.1-sol', session: SESSION, dynamicTools: [] })
  assert.deepEqual(again, { threadId: 'thr-1', isNew: false })
  await stop(bridge)
})

test('compactação: só com a thread parada; o turno novo espera ela acabar, e com turno em curso nada se pede', async () => {
  const bridge = await startBridge('compact', { FAKE_COMPACT_MS: '600' })
  await readUntil(bridge, 'k', await turn(bridge, 'k', 'ola'), 'done')
  assert.deepEqual(await post(bridge, '/compact', { key: 'k' }), { isCompacting: true })
  assert.deepEqual(await post(bridge, '/compact', { key: 'k' }), { isCompacting: false })
  const started = performance.now()
  const { seq } = await post(bridge, '/turns', { key: 'k', text: 'espera', model: 'gpt-6.1-sol' })
  assert.ok(performance.now() - started >= 500, `o turno abriu em ${Math.round(performance.now() - started)} ms`)
  assert.deepEqual(await post(bridge, '/compact', { key: 'k' }), { isCompacting: false })
  assert.equal(asked(bridge, 'thread/compact/start').length, 1)
  await post(bridge, '/interrupt', { key: 'k' })
  assert.equal(lastDone((await readUntil(bridge, 'k', seq as number, 'done')).events)?.kind, 'done')
  assert.deepEqual((await call(bridge, 'POST', '/compact', { key: 'desconhecida' })).body, { isCompacting: false })
  await stop(bridge)
})

test('compactação sem aviso de fim: o fim atrasado de outro turno não a encerra; o turno espera o prazo e segue', async () => {
  const bridge = await startBridge('compact-lost', { FAKE_COMPACT_MS: 'never', FAKE_COMPACT_STRAY: '1' }, ['--compact-wait-ms', '400'])
  await readUntil(bridge, 'k', await turn(bridge, 'k', 'ola'), 'done')
  assert.deepEqual(await post(bridge, '/compact', { key: 'k' }), { isCompacting: true })
  const started = performance.now()
  const first = await post(bridge, '/turns', { key: 'k', text: 'segue', model: 'gpt-6.1-sol' })
  assert.ok(performance.now() - started >= 350, `o turno abriu em ${Math.round(performance.now() - started)} ms, antes do prazo`)
  await post(bridge, '/interrupt', { key: 'k' })
  assert.equal(lastDone((await readUntil(bridge, 'k', first.seq as number, 'done')).events)?.kind, 'done')
  // A compactação vencida saiu da thread: ela aceita outra.
  assert.deepEqual(await post(bridge, '/compact', { key: 'k' }), { isCompacting: true })
  await stop(bridge)
})
