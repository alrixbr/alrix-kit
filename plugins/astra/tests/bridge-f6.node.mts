// F6 na ponte, contra o App Server falso: a troca de login. O App Server guarda o login em memória, e a ponte o troca
// quando o `auth.json` do `CODEX_HOME` muda, com a ponte ociosa; a thread de uma conta não é retomada na outra. E o
// `/interrupt` com o dono (o fim do turno do Claude Code): fecha o turno dele, em curso ou à espera, e só o dele.
// Roda com: node --test --experimental-strip-types --test-concurrency=1 <este arquivo>
import assert from 'node:assert/strict'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { accountOf } from '../bridge/appserver.mts'
import { createBindings, fingerprintOf } from '../bridge/bindings.mts'
import { asked, type Bridge, call, codexHome, exited, HERE, type Json, logged, MEMORY, post, readUntil, startBridge, stateDir, turn } from './fixtures/bridge-harness.mts'

const SESSION = `s${process.pid}f6`
const MAIN = `main:${SESSION}`
const A = { email: 'a@example.invalid', planType: 'pro' }
const B = { email: 'b@example.invalid', planType: 'business' }
let logins = 0

const accountFile = (name: string): string => join(codexHome(name), 'conta.json')
const bindingOf = (name: string): Json => JSON.parse(readFileSync(join(stateDir(name), SESSION, `main_${SESSION}.json`), 'utf8')) as Json
/** Quantos App Servers falsos a ponte abriu: cada um registra o pid ao subir. */
const servers = (bridge: Bridge): number => logged(bridge).filter(entry => entry.method === 'pid').length
const ensure = (bridge: Bridge, key: string, session?: string): Promise<Json> =>
  post(bridge, '/threads/ensure', { key, cwd: HERE, model: 'gpt-6.1-sol', session, dynamicTools: [MEMORY] })

/** Um login no disco: o `auth.json` muda, com o mtime adiantado (o teste não depende da resolução do relógio). */
function login(name: string, account?: typeof A): void {
  logins += 1
  const file = join(codexHome(name), 'auth.json')
  writeFileSync(file, JSON.stringify({ fake: logins }))
  const at = new Date(Date.now() + logins * 10_000)
  utimesSync(file, at, at)
  if (account !== undefined) writeFileSync(accountFile(name), JSON.stringify(account))
}

async function ask(bridge: Bridge, key: string, text: string): Promise<void> {
  await readUntil(bridge, key, await turn(bridge, key, text, { session: SESSION }), 'done')
}

async function stop(bridge: Bridge): Promise<void> {
  const gone = exited(bridge)
  await post(bridge, '/shutdown', {})
  await gone
}

test('o auth.json igual não troca o App Server; o token renovado (mesma conta) troca, e a thread volta pelo thread/resume', async () => {
  login('renova')
  const bridge = await startBridge('renova')
  await ask(bridge, MAIN, 'ola')
  await ask(bridge, MAIN, 'ola')
  assert.equal(servers(bridge), 1)
  login('renova')
  await ask(bridge, MAIN, 'ola')
  assert.equal(servers(bridge), 2)
  assert.deepEqual(asked(bridge, 'thread/resume').map(params => params.threadId), ['thr-1'])
  assert.equal(asked(bridge, 'thread/start').length, 1)
  await stop(bridge)
})

test('outra conta: a thread da anterior não volta, a nova recebe a conversa (isNew), e o binding guarda a conta nova', async () => {
  login('conta', A)
  const bridge = await startBridge('conta', { FAKE_ACCOUNT_FILE: accountFile('conta') })
  await ask(bridge, MAIN, 'ola')
  assert.equal(bindingOf('conta').account, accountOf(A))
  login('conta', B)
  assert.equal((await ensure(bridge, MAIN, SESSION)).isNew, true)
  assert.equal(servers(bridge), 2)
  assert.equal(asked(bridge, 'thread/resume').length, 0)
  assert.equal(asked(bridge, 'thread/start').length, 2)
  assert.equal(bindingOf('conta').account, accountOf(B))
  await stop(bridge)
})

test('ponte nova: o binding sem conta (de antes da F6) volta pelo thread/resume; o de outra conta, não', async () => {
  const bindings = createBindings(stateDir('antigo'))
  const fingerprint = fingerprintOf([MEMORY], undefined)
  const saved = { cwd: HERE, model: 'gpt-6.1-sol', fingerprint, updatedAt: new Date().toISOString() }
  bindings.write(SESSION, MAIN, { ...saved, threadId: 'thr-velha' })
  bindings.write(SESSION, 'sub', { ...saved, threadId: 'thr-de-outra', account: accountOf({ email: 'outra@example.invalid', planType: 'plus' }) })
  const bridge = await startBridge('antigo')
  assert.equal((await ensure(bridge, MAIN, SESSION)).isNew, false)
  assert.equal((await ensure(bridge, 'sub', SESSION)).isNew, true)
  assert.deepEqual(asked(bridge, 'thread/resume').map(params => params.threadId), ['thr-velha'])
  await stop(bridge)
})

test('turno em curso: o login novo espera; o App Server só troca na primeira ensure com a ponte ociosa', async () => {
  login('ocupada')
  const bridge = await startBridge('ocupada')
  const after = await turn(bridge, 'a', 'espera')
  login('ocupada')
  await ensure(bridge, 'b')
  assert.equal(servers(bridge), 1)
  await post(bridge, '/interrupt', { key: 'a' })
  await readUntil(bridge, 'a', after, 'done')
  await ensure(bridge, 'b')
  assert.equal(servers(bridge), 2)
  await stop(bridge)
})

test('compactação em curso também segura a troca de login', async () => {
  login('compacta')
  const bridge = await startBridge('compacta', { FAKE_COMPACT_MS: 'never' })
  await ensure(bridge, 'k')
  assert.deepEqual(await post(bridge, '/compact', { key: 'k' }), { isCompacting: true })
  login('compacta')
  await ensure(bridge, 'outra')
  assert.equal(servers(bridge), 1)
  await stop(bridge)
})

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const TURN = { model: 'gpt-6.1-sol', effort: 'low' }

test('Esc com o /turns à espera da compactação: o /interrupt do dono o cancela, o de outro não, e nada começa depois', async () => {
  const bridge = await startBridge('esc-compacta', { FAKE_COMPACT_MS: '3000' })
  await ensure(bridge, 'k')
  assert.deepEqual(await post(bridge, '/compact', { key: 'k' }), { isCompacting: true })
  const waiting = call(bridge, 'POST', '/turns', { key: 'k', text: 'ola', ...TURN, owner: 'T1' })
  await wait(300)
  await post(bridge, '/interrupt', { key: 'k', owner: 'outro' })
  assert.equal(await Promise.race([waiting.then(() => 'respondeu'), wait(300).then(() => 'esperando')]), 'esperando')
  const cancelledAt = Date.now()
  await post(bridge, '/interrupt', { key: 'k', owner: 'T1' })
  assert.deepEqual(await waiting, { status: 500, body: { error: 'o turno foi interrompido antes de começar' } })
  // Na hora, e não quando a compactação acaba.
  assert.ok(Date.now() - cancelledAt < 1_000)
  await wait(3_000)
  assert.equal(asked(bridge, 'turn/start').length, 0)
  await readUntil(bridge, 'k', await turn(bridge, 'k', 'ola'), 'done')
  assert.equal(asked(bridge, 'turn/start').length, 1)
  await stop(bridge)
})

test('Esc durante o turn/start, ainda sem o id: a ponte interrompe o turno assim que o id chega', async () => {
  const bridge = await startBridge('esc-start', { FAKE_START_MS: '800' })
  await ensure(bridge, 'k')
  const starting = post(bridge, '/turns', { key: 'k', text: 'espera', ...TURN, owner: 'T1' })
  await wait(300)
  await post(bridge, '/interrupt', { key: 'k', owner: 'T1' })
  const { turnId, seq } = await starting
  await readUntil(bridge, 'k', seq as number, 'done')
  assert.deepEqual(asked(bridge, 'turn/interrupt').map(params => params.turnId), [turnId])
  await stop(bridge)
})

test('o /interrupt de outro dono não fecha o turno em curso; o do dono fecha', async () => {
  const bridge = await startBridge('dono')
  await ensure(bridge, 'k')
  const { seq } = await post(bridge, '/turns', { key: 'k', text: 'espera', ...TURN, owner: 'T1' })
  await post(bridge, '/interrupt', { key: 'k', owner: 'T0' })
  await wait(300)
  assert.equal(asked(bridge, 'turn/interrupt').length, 0)
  await post(bridge, '/interrupt', { key: 'k', owner: 'T1' })
  await readUntil(bridge, 'k', seq as number, 'done')
  assert.equal(asked(bridge, 'turn/interrupt').length, 1)
  await stop(bridge)
})
