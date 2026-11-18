// A ponte nativa sem Codex de verdade: as funções puras direto, e o processo inteiro (`bridge/main.mts`) contra o App
// Server falso de `fixtures/`. Roda com: node --test --experimental-strip-types --test-concurrency=1 <este arquivo>
// As pastas dos sockets e dos registros: `fixtures/bridge-harness.mts`.
import assert from 'node:assert/strict'
import { chmodSync, chownSync, existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { AppServer } from '../bridge/appserver.mts'
import { translate } from '../bridge/events.mts'
import type { BridgeEvent } from '../bridge/proto.mts'
import { createThreads } from '../bridge/threads.mts'
import {
  call, exited, HERE, isAlive, IS_WINDOWS, type Json, logged, MEMORY, modeOf, pidOf, post, readUntil, RUNTIME, scratchTmp, shutdown, startBridge, startFailing, texts, turn, UID,
} from './fixtures/bridge-harness.mts'

test('tradução: o comentário vira pensamento, a resposta vira texto, e o fim sem pedaços não se repete', () => {
  const started = translate('item/started', { item: { type: 'agentMessage', id: 'c', phase: 'commentary' } }, new Map(), new Set())
  assert.deepEqual(started.phase, ['c', 'commentary'])
  const phases = new Map([['c', 'commentary']])
  assert.deepEqual(translate('item/agentMessage/delta', { itemId: 'c', delta: 'vendo' }, phases, new Set()).events, [{ kind: 'thinking', delta: 'vendo' }])
  assert.deepEqual(translate('item/agentMessage/delta', { itemId: 'f', delta: 'Oi' }, phases, new Set()).events, [{ kind: 'text', delta: 'Oi' }])
  assert.deepEqual(translate('item/completed', { item: { type: 'agentMessage', id: 'f', text: 'Oi' } }, phases, new Set(['f'])).events, [])
  assert.deepEqual(translate('item/completed', { item: { type: 'agentMessage', id: 'g', text: 'Tudo' } }, phases, new Set()).events, [{ kind: 'text', delta: 'Tudo' }])
  const failed = translate('turn/completed', { turn: { id: 't', status: 'failed', error: { message: 'cota' } } }, phases, new Set())
  assert.deepEqual(failed.events, [{ kind: 'done', status: 'failed', error: 'cota' }])
  assert.equal(failed.isTurnOver, true)
})

test('threads: a hora é respondida, aprovação e pedido desconhecido são recusados, aviso fora do turno não entra', async () => {
  const responses: unknown[] = []
  const refusals: string[] = []
  const server: AppServer = {
    request: async method => (method === 'thread/start' ? { thread: { id: 'thr-1' } } : { turn: { id: 'turn-1' } }),
    respond: (_id, result) => responses.push(result),
    refuse: (_id, message) => refusals.push(message),
    close: async () => {},
    version: '0.169.0',
    isValidated: true,
    account: 'conta',
  }
  const threads = createThreads(async () => server)
  await threads.ensure({ key: 'k', cwd: '/x', model: 'gpt-6.1-sol', dynamicTools: [] })
  threads.onRequest(1, 'currentTime/read', { threadId: 'thr-1' })
  threads.onRequest(2, 'item/commandExecution/requestApproval', { threadId: 'thr-1' })
  threads.onRequest(3, 'mcpServer/elicitation/request', { threadId: 'thr-1' })
  assert.equal(typeof (responses[0] as { currentTimeAt?: unknown }).currentTimeAt, 'number')
  assert.deepEqual(refusals, ['a ponte do Claude Code não atende item/commandExecution/requestApproval', 'a ponte do Claude Code não atende mcpServer/elicitation/request'])
  threads.onNotification('item/agentMessage/delta', { threadId: 'thr-1', turnId: 'velho', itemId: 'm', delta: 'fora' })
  await threads.startTurn('k', 'oi', 'gpt-6.1-sol')
  threads.onNotification('item/agentMessage/delta', { threadId: 'thr-1', turnId: 'velho', itemId: 'm', delta: 'de outro turno' })
  threads.onNotification('item/agentMessage/delta', { threadId: 'thr-1', turnId: 'turn-1', itemId: 'm', delta: 'deste turno' })
  const batch = await threads.events('k', 0, 0, new AbortController().signal)
  assert.deepEqual(batch?.events.map(event => (event.kind === 'text' ? event.delta : event.kind)), ['deste turno'])
})

test('a ponte sobe, diz READY, atende /health antes do App Server e sai pelo /shutdown', async () => {
  const bridge = await startBridge('health')
  if (!IS_WINDOWS) {
    assert.equal(statSync(bridge.socket).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(bridge.socket)).mode & 0o777, 0o700)
  }
  const { body } = await call(bridge, 'GET', '/health')
  assert.deepEqual(body, { epoch: bridge.epoch, codex: null, validated: '0.169.0', threads: 0, isBusy: false })
  assert.equal(await shutdown(bridge), 0)
  if (IS_WINDOWS) return
  assert.equal(existsSync(dirname(bridge.socket)), false)
  assert.equal(existsSync(dirname(dirname(bridge.socket))), true)
})

test('o SIGTERM fecha a ponte limpa onde há sinal (Linux e macOS)', { skip: IS_WINDOWS && 'o Windows não tem SIGTERM: lá a ponte fecha pelo /shutdown ou quando o Claude Code sai' }, async () => {
  const bridge = await startBridge('sigterm')
  const gone = exited(bridge)
  bridge.child.kill('SIGTERM')
  assert.equal(await gone, 0)
  assert.equal(existsSync(dirname(bridge.socket)), false)
})

test('sandbox: a thread abre com o que o mod pediu; sem pedido ou com valor desconhecido, workspace-write, nunca acesso total', async () => {
  const bridge = await startBridge('sandbox')
  const ask = (key: string, sandbox?: string, developerInstructions?: string): Promise<Json> =>
    post(bridge, '/threads/ensure', { key, cwd: HERE, model: 'gpt-6-astra', sandbox, developerInstructions, dynamicTools: [] })
  await ask('r', 'read-only', 'PAPEL')
  await ask('w', 'workspace-write')
  await ask('f', 'danger-full-access')
  await ask('n')
  await ask('x', 'tudo')
  const starts = logged(bridge).filter(entry => entry.method === 'thread/start').map(entry => entry.params as Json)
  assert.deepEqual(starts.map(start => [start.sandbox, start.developerInstructions]), [
    ['read-only', 'PAPEL'], ['workspace-write', null], ['danger-full-access', null], ['workspace-write', null], ['workspace-write', null],
  ])
  await shutdown(bridge)
})

test('um turno: thread em workspace-write e sem serviceTier, comentário, comando, uso e resposta', async () => {
  const bridge = await startBridge('turno')
  const after = await turn(bridge, 'main:a', 'ola')
  const { events } = await readUntil(bridge, 'main:a', after, 'done')
  assert.deepEqual(events.map(event => event.kind), ['thinking', 'item', 'usage', 'text', 'done'])
  assert.deepEqual(events.find(event => event.kind === 'item'), { seq: 2, kind: 'item', phase: 'completed', item: { type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0 } })
  assert.deepEqual(events.at(-2), { seq: 4, kind: 'text', delta: 'Oi' })
  const asked = logged(bridge)
  const hello = asked.find(entry => entry.method === 'initialize')?.params as Json
  assert.equal((hello.clientInfo as Json).name, 'alrix_cc_bridge')
  const start = asked.find(entry => entry.method === 'thread/start')?.params as Json
  assert.equal(start.approvalPolicy, 'never')
  assert.equal(start.sandbox, 'workspace-write')
  assert.equal(start.ephemeral, false)
  assert.deepEqual(start.dynamicTools, [MEMORY])
  const turnStart = asked.find(entry => entry.method === 'turn/start')?.params as Json
  assert.equal(turnStart.effort, 'low')
  assert.equal('serviceTier' in start || 'serviceTierForTurn' in turnStart, false)
  assert.equal((await call(bridge, 'GET', '/health')).body.codex, '0.169.0')
  assert.deepEqual(await post(bridge, '/threads/ensure', { key: 'main:a', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [] }), { threadId: 'thr-1', isNew: false })
  const gone = exited(bridge)
  await post(bridge, '/shutdown', {})
  assert.equal(await gone, 0)
  const pid = (asked.find(entry => entry.method === 'pid')?.params as Json).pid as number
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(isAlive(pid), false)
})

test('ferramentas do Claude Code: o turno espera o resultado; duas seguidas saem no mesmo lote', async () => {
  const bridge = await startBridge('ferramenta')
  const first = await readUntil(bridge, 'k', await turn(bridge, 'k', 'ferramenta'), 'toolCall')
  assert.deepEqual(first.events.at(-1), { seq: 1, kind: 'toolCall', callId: 'call-1', tool: MEMORY.name, args: { consulta: 'astra' } })
  await post(bridge, '/tool-result', { key: 'k', callId: 'call-1', text: 'nota', isError: false })
  assert.equal((await call(bridge, 'POST', '/tool-result', { key: 'k', callId: 'call-1', text: 'de novo' })).status, 409)
  const done = await readUntil(bridge, 'k', first.next, 'done')
  assert.deepEqual(done.events.filter(event => event.kind === 'text'), [{ seq: 2, kind: 'text', delta: 'Recebi: nota (true)' }])
  const both = await call(bridge, 'GET', `/events?key=k&after=${await turn(bridge, 'k', 'duas')}&waitMs=3000`)
  const calls = (both.body.events as BridgeEvent[]).filter(event => event.kind === 'toolCall')
  assert.deepEqual(calls.map(event => event.callId), ['call-a', 'call-b'])
  await post(bridge, '/tool-result', { key: 'k', callId: 'call-a', text: 'a', isError: false })
  await post(bridge, '/tool-result', { key: 'k', callId: 'call-b', text: 'b', isError: true })
  const end = await readUntil(bridge, 'k', both.body.next as number, 'done')
  assert.deepEqual(texts(end.events), ['a (true) e b (false)'])
  bridge.child.kill('SIGTERM')
})

test('a hora sai da ponte, a aprovação é recusada, e o Esc interrompe o turno parado', async () => {
  const bridge = await startBridge('pedidos')
  const hour = await readUntil(bridge, 'k', await turn(bridge, 'k', 'hora'), 'done')
  assert.deepEqual(texts(hour.events), ['hora number'])
  const approval = await readUntil(bridge, 'k', await turn(bridge, 'k', 'aprovacao'), 'done')
  assert.deepEqual(texts(approval.events), ['recusado: a ponte do Claude Code não atende item/commandExecution/requestApproval'])
  const after = await turn(bridge, 'k', 'espera')
  assert.deepEqual(await post(bridge, '/interrupt', { key: 'k' }), { isInterrupting: true })
  const stopped = await readUntil(bridge, 'k', after, 'done')
  assert.deepEqual(stopped.events.at(-1), { seq: stopped.next, kind: 'done', status: 'interrupted' })
  bridge.child.kill('SIGTERM')
})

test('turno novo logo depois do /interrupt: um turn/interrupt só, e o cursor do /turns fica depois do fim do interrompido', async () => {
  const bridge = await startBridge('cursor', { FAKE_INTERRUPT_MS: '300' })
  await readUntil(bridge, 'k', await turn(bridge, 'k', 'presa'), 'toolCall')
  assert.deepEqual(await post(bridge, '/interrupt', { key: 'k' }), { isInterrupting: true })
  const { events } = await readUntil(bridge, 'k', await turn(bridge, 'k', 'ola'), 'done')
  assert.deepEqual(events.map(event => event.kind), ['thinking', 'item', 'usage', 'text', 'done'])
  assert.deepEqual(events.at(-1), { seq: events.at(-1)?.seq, kind: 'done', status: 'completed' })
  assert.equal(logged(bridge).filter(entry => entry.method === 'turn/interrupt').length, 1)
  bridge.child.kill('SIGTERM')
})

test('o App Server que cai falha o turno com o motivo, e a thread é retomada no App Server seguinte', async () => {
  const bridge = await startBridge('queda')
  const failed = await readUntil(bridge, 'k', await turn(bridge, 'k', 'cair'), 'done')
  const done = failed.events.at(-1)
  assert.equal(done?.kind === 'done' && done.status, 'failed')
  assert.match(done?.kind === 'done' ? (done.error ?? '') : '', /exit 3/)
  const again = await post(bridge, '/threads/ensure', { key: 'k', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [MEMORY] })
  assert.deepEqual(again, { threadId: 'thr-1', isNew: false })
  assert.deepEqual(logged(bridge).filter(entry => entry.method === 'thread/resume').map(entry => (entry.params as Json).threadId), ['thr-1'])
  const started = await post(bridge, '/turns', { key: 'k', text: 'ola', model: 'gpt-6.1-sol' })
  assert.equal(started.seq, failed.next)
  const ok = await readUntil(bridge, 'k', failed.next, 'done')
  assert.deepEqual(ok.events.at(-1), { seq: ok.next, kind: 'done', status: 'completed' })
  assert.deepEqual(texts(ok.events), ['Oi'])
  bridge.child.kill('SIGTERM')
})

test('sem login do ChatGPT no Codex, a ponte recusa com 503 e a frase diz como logar', async () => {
  const bridge = await startBridge('conta', { FAKE_ACCOUNT: 'apikey' })
  const answer = await call(bridge, 'POST', '/threads/ensure', { key: 'k', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [] })
  assert.equal(answer.status, 503)
  assert.match(String(answer.body.error), /^O Codex desta máquina está sem login .*`codex login`/)
  bridge.child.kill('SIGTERM')
})

const UNIX_ONLY = { skip: IS_WINDOWS && 'socket Unix e dono por uid só existem no Linux e no macOS; no Windows o canal é TCP com segredo' }

test('sem XDG_RUNTIME_DIR: a pasta vai para o tmpdir com o uid no nome, 0700, e a pasta própria aberta demais volta a 0700', UNIX_ONLY, async () => {
  const fresh = scratchTmp('fresh')
  const bridge = await startBridge('xdg-fresh', { XDG_RUNTIME_DIR: '', TMPDIR: fresh })
  const parent = join(fresh, `alrix-astra-${UID}`)
  assert.ok(bridge.socket.startsWith(`${parent}/`), bridge.socket)
  assert.equal(modeOf(parent), 0o700)
  assert.equal(statSync(parent).uid, UID)
  assert.equal(modeOf(dirname(bridge.socket)), 0o700)
  bridge.child.kill('SIGTERM')
  const wide = scratchTmp('wide')
  mkdirSync(join(wide, `alrix-astra-${UID}`))
  chmodSync(join(wide, `alrix-astra-${UID}`), 0o755)
  const again = await startBridge('xdg-wide', { XDG_RUNTIME_DIR: '', TMPDIR: wide })
  assert.equal(modeOf(join(wide, `alrix-astra-${UID}`)), 0o700)
  again.child.kill('SIGTERM')
})

test('pasta de outro dono ou link simbólico no lugar da pasta da ponte: ela não sobe e diz o motivo numa linha', UNIX_ONLY, async () => {
  const foreign = scratchTmp('foreign')
  mkdirSync(join(foreign, `alrix-astra-${UID}`))
  chownSync(join(foreign, `alrix-astra-${UID}`), 65534, 65534)
  const owned = await startFailing('foreign', { XDG_RUNTIME_DIR: '', TMPDIR: foreign })
  assert.equal(owned.code, 1)
  assert.match(owned.line, /^a ponte não subiu: .*alrix-astra-\d+ não é uma pasta deste usuário/)
  const linked = scratchTmp('linked')
  symlinkSync(RUNTIME, join(linked, `alrix-astra-${UID}`))
  const link = await startFailing('linked', { XDG_RUNTIME_DIR: '', TMPDIR: linked })
  assert.equal(link.code, 1)
  assert.match(link.line, /não é uma pasta deste usuário/)
})

test('caminho de socket acima de 100 bytes: a ponte recusa antes de criar qualquer pasta', UNIX_ONLY, async () => {
  const long = join(RUNTIME, `long-${process.pid}-${'x'.repeat(50)}`)
  const result = await startFailing('long', { XDG_RUNTIME_DIR: long })
  assert.equal(result.code, 1)
  assert.match(result.line, /^a ponte não subiu: o caminho do socket passa de 100 bytes/)
  assert.equal(existsSync(long), false)
})

test('desligar: o App Server que fecha com o fim do stdin sai na hora, sem esperar o prazo', async () => {
  const bridge = await startBridge('educado')
  await post(bridge, '/threads/ensure', { key: 'k', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [] })
  const pid = await pidOf(bridge)
  const started = performance.now()
  assert.equal(await shutdown(bridge), 0)
  assert.ok(performance.now() - started < 2_000, `a ponte saiu em ${Math.round(performance.now() - started)} ms`)
  assert.equal(isAlive(pid), false)
})

test('desligar: o Codex que ignora o fim do stdin e o SIGTERM é morto aos 5 s, e a ponte sai depois dele, sem deixar o socket', async () => {
  const bridge = await startBridge('teimoso', { FAKE_IGNORE_TERM: '1' })
  await post(bridge, '/threads/ensure', { key: 'k', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [] })
  const pid = await pidOf(bridge)
  const started = performance.now()
  assert.equal(await shutdown(bridge), 0)
  const waited = performance.now() - started
  assert.ok(waited >= 4_500 && waited < 8_000, `a ponte saiu em ${Math.round(waited)} ms`)
  assert.equal(isAlive(pid), false)
  if (!IS_WINDOWS) assert.equal(existsSync(bridge.socket), false)
})

test('desligar no meio da partida: o App Server que ainda está no initialize morre junto, sem esperar o prazo', async () => {
  const bridge = await startBridge('partida', { FAKE_SLOW_INIT: '1' })
  const ensuring = call(bridge, 'POST', '/threads/ensure', { key: 'k', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [] }).catch(() => undefined)
  const pid = await pidOf(bridge)
  const started = performance.now()
  assert.equal(await shutdown(bridge), 0)
  assert.ok(performance.now() - started < 2_000, `a ponte saiu em ${Math.round(performance.now() - started)} ms`)
  assert.equal(isAlive(pid), false)
  await ensuring
})
