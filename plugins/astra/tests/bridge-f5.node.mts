// F5 na ponte, contra o App Server falso: o steer amarrado ao turno do Codex que o mod indicou e a config de toda thread
// (o CLAUDE.md do projeto sem AGENTS.md, e o Codex sem agente próprio).
// Roda com: node --test --experimental-strip-types --test-concurrency=1 <este arquivo>
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMPACTION, THREAD_CONFIG } from '../bridge/ensure.mts'
import { asked, call, exited, HERE, MEMORY, post, readUntil, startBridge, turn } from './fixtures/bridge-harness.mts'

async function stop(bridge: Awaited<ReturnType<typeof startBridge>>): Promise<void> {
  const gone = exited(bridge)
  await post(bridge, '/shutdown', {})
  await gone
}

test('steer amarrado: o turno do Codex que não é o indicado recusa (409) sem pedir ao App Server; o indicado aceita', async () => {
  const bridge = await startBridge('steer-turno')
  await readUntil(bridge, 'k', await turn(bridge, 'k', 'ouvir'), 'toolCall')
  const other = await call(bridge, 'POST', '/steer', { key: 'k', text: 'era do turno anterior', turnId: 'turn-0' })
  assert.equal(other.status, 409)
  assert.equal(asked(bridge, 'turn/steer').length, 0)
  assert.deepEqual(await post(bridge, '/steer', { key: 'k', text: 'recado', turnId: 'turn-1' }), { isSteered: true })
  assert.deepEqual(asked(bridge, 'turn/steer'), [{ threadId: 'thr-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'recado', text_elements: [] }] }])
  await stop(bridge)
})

test('config de toda thread: o CLAUDE.md vale sem AGENTS.md, e o Codex não abre agente próprio; o teto de contexto segue', async () => {
  assert.deepEqual(THREAD_CONFIG, { project_doc_fallback_filenames: ['CLAUDE.md'], 'agents.enabled': false, 'features.multi_agent_v2': false })
  const bridge = await startBridge('config')
  await post(bridge, '/threads/ensure', { key: 'k', cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [MEMORY] })
  assert.deepEqual(asked(bridge, 'thread/start')[0]?.config, { ...COMPACTION, ...THREAD_CONFIG })
  await stop(bridge)
})
