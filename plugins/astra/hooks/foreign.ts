import type { EngineInterface, On } from 'claude-code'
import type { AstraForeignAgent } from '../types/index'

type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]

/**
 * Os tipos de agente que outro plugin registra (`$.agent.register`), lidos no evento `agent.register`: o motor não põe
 * o prompt de um tipo no `turn.step` nem no `prompt.compose`, e o registro é o único lugar onde ele passa por um mod.
 * Guarda o prompt e as ferramentas de cada `<plugin>:<nome>` na memória e no `$.state` (que sobrevive ao recarregamento
 * do mod). O tipo de um arquivo `agents/*.md` de outro plugin não passa por aqui: ele roda sem o prompt dele, só com
 * o papel da ponte, e com o sandbox de quem não diz as ferramentas (`workspace-write`).
 */
const AGENTS = { plugin: 'astra', key: 'agents' } as const
const known = new Map<string, AstraForeignAgent>()

const recordOf = (spec: AgentSpec): AstraForeignAgent => ({
  prompt: spec.prompt,
  ...(spec.tools === undefined ? {} : { tools: [...spec.tools] }),
  ...(spec.disallowedTools === undefined ? {} : { disallowedTools: [...spec.disallowedTools] }),
})

/** O tipo de outro plugin como ele o registrou nesta sessão; undefined se não passou pelo registro. */
export async function foreignAgent($: EngineInterface, type: string): Promise<AstraForeignAgent | undefined> {
  const held = known.get(type)
  if (held !== undefined) return held
  const { value } = await $.state.get(AGENTS)
  return value?.[type]
}

/** Só observa: o registro segue como o outro plugin o pediu, e a falha aqui não o barra. */
export function registerForeign(on: On): void {
  on('agent.register', async ($, e, next) => {
    const answer = await next(e)
    const plugin = next.origin.plugin
    const type = 'value' in answer ? answer.value?.agent : undefined
    // Recusado (`deny`), sem nome, ou o tipo é do próprio astra: nada a guardar. O nome é o completo, como o motor o
    // deu (`<plugin>:<nome>`), que é o `type` do agente na lista da sessão.
    if (type === undefined || plugin === 'astra') return answer
    const record = recordOf(e)
    known.set(type, record)
    const { value } = await $.state.get(AGENTS)
    await $.state.set(AGENTS, { ...(value ?? {}), [type]: record })
    return answer
    // O `next(e)` do `.catch` repete o que o registro já respondeu, sem registrar de novo.
  }).catch(($, e, next) => next(e))
}
