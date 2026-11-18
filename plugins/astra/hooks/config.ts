import type { PluginOptions } from 'claude-code'

/**
 * As opções que a pessoa escolhe no `/config` (o `userConfig` do plugin.json), lidas a cada carga do módulo.
 * - `fullAccess`: o Codex dos agentes construtores do astra e do loop principal roda sem sandbox. Desligada, ele grava
 *   só na pasta de trabalho (`workspace-write`). Tipo de agente de outro plugin nunca recebe acesso total.
 * - `codexPath`: o caminho do programa do Codex, quando ele não está no PATH.
 */
export type Config = { fullAccess: boolean; codexPath: string }

export const DEFAULTS: Config = { fullAccess: false, codexPath: '' }

let current: Config = DEFAULTS

export function readConfig(options: PluginOptions | undefined): Config {
  const fullAccess = options?.fullAccess === true
  const codexPath = typeof options?.codexPath === 'string' ? options.codexPath.trim() : ''
  current = { fullAccess, codexPath }
  return current
}

export const config = (): Config => current
