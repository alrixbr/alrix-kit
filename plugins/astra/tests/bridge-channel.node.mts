// O canal mod ↔ ponte e o que a ponte acha na máquina: o segredo conferido em todo pedido, o TCP só em 127.0.0.1 (o
// canal do Windows), a busca do Codex do jeito que a pessoa o instalou, a pasta de estado de cada sistema e o Node mínimo.
// Roda com: node --test --experimental-strip-types --test-concurrency=1 <este arquivo>
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import { test } from 'node:test'
import { stateRoot } from '../bridge/bindings.mts'
import { channelFor, LOOPBACK, SECRET_HEADER } from '../bridge/channel.mts'
import { type Disk, findCodex, NOT_FOUND, pathDirs } from '../bridge/codex-path.mts'
import { isEnoughNode, oldNodeLine } from '../bridge/node-version.mjs'
import { call, IS_WINDOWS, raw, shutdown, startBridge, startFailing } from './fixtures/bridge-harness.mts'

test('canal do sistema: TCP em 127.0.0.1 no Windows, socket Unix no resto, e o READY diz qual', async () => {
  const bridge = await startBridge('canal')
  if (IS_WINDOWS) assert.match(bridge.socket, /^http:\/\/127\.0\.0\.1:\d+$/)
  else assert.ok(bridge.socket.startsWith('/'), bridge.socket)
  assert.match(bridge.secret, /^[\w-]{43}$/)
  assert.equal((await call(bridge, 'GET', '/health')).status, 200)
  await shutdown(bridge)
})

for (const channel of ['tcp', ...(IS_WINDOWS ? [] : ['unix'])] as const) {
  test(`${channel}: sem o segredo, com outro segredo ou com o segredo pela metade, 401 e nada acontece`, async () => {
    const bridge = await startBridge(`segredo-${channel}`, {}, ['--channel', channel])
    const ensure = { key: 'k', cwd: '.', model: 'gpt-6.1-sol', dynamicTools: [] }
    for (const headers of [{}, { [SECRET_HEADER]: 'x'.repeat(43) }, { [SECRET_HEADER]: bridge.secret.slice(0, 20) }, { authorization: `Bearer ${bridge.secret}` }]) {
      const answer = await raw(bridge, 'POST', '/threads/ensure', headers, ensure)
      assert.deepEqual(answer, { status: 401, body: { error: 'pedido sem o segredo desta ponte' } })
      assert.equal((await raw(bridge, 'POST', '/shutdown', headers, {})).status, 401)
    }
    assert.equal((await call(bridge, 'GET', '/health')).body.threads, 0)
    await shutdown(bridge)
  })
}

test('tcp: escuta só em 127.0.0.1; Host de outro nome e pedido de navegador (Origin) são recusados mesmo com o segredo', async () => {
  const bridge = await startBridge('tcp-host', {}, ['--channel', 'tcp'])
  const url = new URL(bridge.socket)
  assert.equal(url.hostname, LOOPBACK)
  const secret = { [SECRET_HEADER]: bridge.secret }
  assert.deepEqual(await raw(bridge, 'GET', '/health', { ...secret, host: `localhost:${url.port}` }), { status: 401, body: { error: 'pedido com um Host que não é o desta ponte' } })
  assert.deepEqual(await raw(bridge, 'GET', '/health', { ...secret, host: `ataque.example:${url.port}` }), { status: 401, body: { error: 'pedido com um Host que não é o desta ponte' } })
  assert.deepEqual(await raw(bridge, 'GET', '/health', { ...secret, origin: 'https://ataque.example' }), { status: 401, body: { error: 'pedido de navegador' } })
  assert.equal((await raw(bridge, 'GET', '/health', secret)).status, 200)
  await shutdown(bridge)
})

test('duas pontes têm portas e segredos diferentes, e o segredo de uma não abre a outra', async () => {
  const first = await startBridge('par-1', {}, ['--channel', 'tcp'])
  const second = await startBridge('par-2', {}, ['--channel', 'tcp'])
  assert.notEqual(first.socket, second.socket)
  assert.notEqual(first.secret, second.secret)
  assert.equal((await raw(second, 'GET', '/health', { [SECRET_HEADER]: first.secret })).status, 401)
  await shutdown(first)
  await shutdown(second)
})

test('canal pedido que o sistema não tem: a ponte não sobe e diz o motivo numa linha', { skip: !IS_WINDOWS && 'só no Windows falta o socket Unix' }, async () => {
  const result = await startFailing('unix-no-windows', {}, ['--channel', 'unix'])
  assert.equal(result.code, 1)
  assert.match(result.line, /^a ponte não subiu: no Windows a ponte não abre socket Unix/)
})

test('channelFor: o canal de cada sistema, e o nome desconhecido recusado', () => {
  assert.deepEqual(channelFor('win32', undefined, 's', 'e'), { kind: 'tcp', host: LOOPBACK })
  assert.deepEqual(channelFor('linux', 'tcp', 's', 'e'), { kind: 'tcp', host: LOOPBACK })
  assert.throws(() => channelFor('linux', 'pipe', 's', 'e'), /--channel precisa ser unix ou tcp/)
})

/** Um disco de mentira: só os arquivos da lista existem; o realpath devolve o caminho como veio. */
const diskOf = (files: readonly string[]): Disk => ({ isFile: path => files.includes(path), realpath: path => path })
const WINDOWS = { platform: 'win32' as const, arch: 'x64', execPath: 'C:\\Program Files\\nodejs\\node.exe' }
const NPM = 'C:\\Users\\pessoa\\AppData\\Roaming\\npm'
const PACKAGE = win32.join(NPM, 'node_modules', '@openai', 'codex')
const NATIVE = win32.join(PACKAGE, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')

test('codex no Windows pelo npm: o codex.cmd vira o codex.exe do pacote, sem shell, com as variáveis que o codex.js poria', () => {
  const found = findCodex({ ...WINDOWS, path: `C:\\Windows\\system32;${NPM}`, disk: diskOf([win32.join(NPM, 'codex.cmd'), win32.join(PACKAGE, 'bin', 'codex.js'), NATIVE]) })
  assert.deepEqual(found, { argv: [NATIVE, 'app-server'], env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: PACKAGE } })
})

test('codex no Windows pelo npm sem o binário do pacote: o codex.js roda com o Node da ponte', () => {
  const script = win32.join(PACKAGE, 'bin', 'codex.js')
  const found = findCodex({ ...WINDOWS, path: NPM, disk: diskOf([win32.join(NPM, 'codex.ps1'), script]) })
  assert.deepEqual(found, { argv: [WINDOWS.execPath, script, 'app-server'], env: {} })
})

test('codex no Windows por winget ou binário: o codex.exe do PATH roda direto; o PATH com aspas e pasta vazia vale', () => {
  const links = 'C:\\Users\\pessoa\\AppData\\Local\\Microsoft\\WinGet\\Links'
  const exe = win32.join(links, 'codex.exe')
  assert.deepEqual(findCodex({ ...WINDOWS, path: `;"${links}";${NPM}`, disk: diskOf([exe, win32.join(NPM, 'codex.cmd')]) }), { argv: [exe, 'app-server'], env: {} })
  assert.deepEqual(pathDirs(`;"${links}"; ;${NPM}`, 'win32'), [links, NPM])
})

test('codex na opção codexPath: vale antes do PATH; o caminho que não existe vira a frase', () => {
  const exe = 'D:\\ferramentas\\codex.exe'
  assert.deepEqual(findCodex({ ...WINDOWS, given: `"${exe}"`, path: NPM, disk: diskOf([exe, win32.join(NPM, 'codex.exe')]) }), { argv: [exe, 'app-server'], env: {} })
  assert.equal(findCodex({ ...WINDOWS, given: 'D:\\nada\\codex.exe', path: NPM, disk: diskOf([]) }), 'O caminho do Codex informado na opção codexPath do astra não existe: D:\\nada\\codex.exe')
})

test('codex que falta ou que o npm deixou pela metade: a frase diz o que fazer', () => {
  assert.equal(findCodex({ ...WINDOWS, path: NPM, disk: diskOf([]) }), NOT_FOUND)
  assert.match(NOT_FOUND, /npm install -g @openai\/codex.*codex login.*codexPath/)
  assert.match(String(findCodex({ ...WINDOWS, path: NPM, disk: diskOf([win32.join(NPM, 'codex.cmd')]) })), /^Achei o Codex em .*codex\.cmd, mas não o binário que ele abre/)
})

test('codex no Linux e no macOS: o primeiro codex do PATH roda direto', () => {
  const bin = '/home/pessoa/.npm-global/bin/codex'
  for (const platform of ['linux', 'darwin'] as const) {
    const found = findCodex({ platform, arch: 'x64', execPath: '/usr/bin/node', path: `/usr/local/bin:${posix.dirname(bin)}`, disk: diskOf([bin]) })
    assert.deepEqual(found, { argv: [bin, 'app-server'], env: {} })
  }
})

test('pasta de estado de cada sistema, e o --state antes dela', () => {
  assert.equal(stateRoot(undefined, 'win32', { LOCALAPPDATA: 'C:\\Users\\pessoa\\AppData\\Local' }, 'C:\\Users\\pessoa'), 'C:\\Users\\pessoa\\AppData\\Local\\alrix-astra\\state')
  assert.equal(stateRoot(undefined, 'win32', {}, 'C:\\Users\\pessoa'), 'C:\\Users\\pessoa\\AppData\\Local\\alrix-astra\\state')
  assert.equal(stateRoot(undefined, 'darwin', {}, '/Users/pessoa'), '/Users/pessoa/Library/Application Support/alrix-astra')
  assert.equal(stateRoot(undefined, 'linux', { XDG_STATE_HOME: '/x/state' }, '/home/pessoa'), '/x/state/alrix-astra')
  assert.equal(stateRoot(undefined, 'linux', {}, '/home/pessoa'), '/home/pessoa/.local/state/alrix-astra')
  assert.equal(stateRoot('/dada', 'win32', {}, 'C:\\x'), '/dada')
})

test('Node mínimo: 22.18 na linha 22, 23.6 na 23, qualquer 24 ou mais; o velho recebe a frase', () => {
  const cases = [['20.19.0', false], ['22.6.0', false], ['22.17.1', false], ['22.18.0', true], ['23.5.0', false], ['23.6.0', true], ['24.0.0', true], ['26.13.0', true]] as const
  for (const [version, expected] of cases) assert.equal(isEnoughNode(version), expected, version)
  assert.match(oldNodeLine('20.19.0'), /^a ponte não subiu: o Node\.js desta máquina é a versão 20\.19\.0, e o astra precisa da 22\.18 ou mais nova\. .*nodejs\.org/)
})
