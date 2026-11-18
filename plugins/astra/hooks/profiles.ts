export type Profile = {
  role: 'builder' | 'codereviewer'
  /**
   * O sandbox do papel: o revisor só lê; o construtor grava na pasta de trabalho, ou na máquina inteira quando a pessoa
   * ligou a opção `fullAccess` (`native-agent.ts`).
   */
  sandbox: 'read-only' | 'workspace-write'
}

/**
 * Tipo de agente (`<plugin>:<nome>`, de `agents/*.md`) → o papel e o sandbox da thread dele no Codex. O modelo e o
 * esforço vêm do `model:` e do `effort:` do próprio `agents/*.md`, que o Claude Code põe em cada passo.
 */
export const PROFILES: ReadonlyMap<string, Profile> = new Map([
  ['astra:xhigh', { role: 'builder', sandbox: 'workspace-write' }],
  ['astra:max', { role: 'builder', sandbox: 'workspace-write' }],
  ['astra:sol', { role: 'builder', sandbox: 'workspace-write' }],
  ['astra:codereviewer', { role: 'codereviewer', sandbox: 'read-only' }],
])
