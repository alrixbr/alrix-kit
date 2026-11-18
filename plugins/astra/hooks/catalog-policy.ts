/**
 * Onde cada ferramenta do Claude Code entra no catálogo que o Codex vê. As diretas ficam sempre à vista; as outras vão
 * no namespace `claude_code` com `deferLoading`, e o Codex as acha pela busca de ferramentas dele. O resto fica fora:
 * o shell (`Bash` e, no Windows, `PowerShell`), `Read`, `Edit`, `Write` e a busca na web o Codex já tem, os modos de
 * plano não servem a ele, e as ferramentas de MCP não entram (o motor não dá o schema delas a um mod, e o arquivo
 * `schemas/claude-tools.json` só traz as do próprio Claude Code).
 * Sem import: o `scripts/sync-tools.mts` (Node) lê a mesma regra.
 */
export type Place = 'direct' | 'deferred'

const DIRECT: ReadonlySet<string> = new Set(['Agent', 'SendMessage', 'ListAgents', 'Skill', 'AskUserQuestion'])
const DEFERRED: ReadonlySet<string> = new Set(['WebFetch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

export function placeOf(name: string): Place | undefined {
  if (DIRECT.has(name)) return 'direct'
  if (DEFERRED.has(name)) return 'deferred'
  return undefined
}
