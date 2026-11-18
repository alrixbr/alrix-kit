/**
 * O agente do loop principal como o Claude Code o resolveu no último pedido (`agent_type` do UserPromptSubmit) e a
 * sessão em que resolveu; `type` null quando a sessão roda sem agente.
 */
export type AstraMainAgent = { sessionId: string; type: string | null }

/**
 * Um tipo de agente que outro plugin registrou (`$.agent.register`), como o astra o leu no evento `agent.register`:
 * o prompt (que vai ao Codex depois do papel da ponte) e as ferramentas (que decidem o sandbox).
 */
export type AstraForeignAgent = { prompt: string; tools?: string[]; disallowedTools?: string[] }

declare module 'claude-code' {
  interface PluginState {
    astra: { mainAgent: AstraMainAgent; agents: Record<string, AstraForeignAgent> }
  }
}
