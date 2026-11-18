import type { AgentInfo } from 'claude-code'

/** Um agente da lista da sessão (`$.agent.list`) com só o que os testes leem; o resto, valores neutros. */
export const agentInfo = (given: Pick<AgentInfo, 'id' | 'type' | 'description' | 'status'> & Partial<Pick<AgentInfo, 'name'>>): AgentInfo => ({
  hasRow: true,
  kind: 'local_agent',
  taskStatus: given.status === 'idle' || given.status === 'waiting' ? 'running' : given.status,
  label: given.description,
  startTime: 0,
  cwd: '/synthetic',
  tokenCount: 0,
  tokenSamples: [],
  ...given,
})

/** O corpo de um pedido `$.http.fetch` como texto (o motor também aceita bytes em base64, que estes testes não mandam). */
export const bodyText = (body: string | { readonly base64: string } | undefined): string => (typeof body === 'string' ? body : '{}')
