// As pastas do mod na máquina de quem instalou: a pasta do usuário, a pasta de configuração do Claude Code
// (CLAUDE_CONFIG_DIR, ou ~/.claude), a pasta de dados do mod dentro dela e a prateleira da pessoa.
import type { EngineInterface } from 'claude-code'

const barras = (valor: string): string => valor.replace(/\\/g, '/').replace(/\/+$/, '')

/** A pasta do usuário, com barras normais (USERPROFILE no Windows, HOME no Linux e no macOS). */
export async function casaDe($: EngineInterface): Promise<string> {
  const valor = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
  return barras(valor)
}

/**
 * A pasta de configuração do Claude Code: a de CLAUDE_CONFIG_DIR, quando a variável existe, senão ~/.claude. É nela
 * que ficam os dados do mod e a prateleira da pessoa, para um perfil separado ter a sua.
 */
export async function configDe($: EngineInterface): Promise<string> {
  const definida = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))?.trim()
  if (definida) return barras(definida)
  return `${await casaDe($)}/.claude`
}

/** A pasta de dados do mod (estado, relatórios, diagnóstico) dentro da pasta de configuração. */
export const dadosDe = (config: string): string => `${config}/alrix-equipe`

/**
 * A prateleira da pessoa: projetos, skills aprovadas, lições, kits e tipos dela. Fica fora da pasta do plugin para
 * sobreviver à atualização; soma à do plugin, e o item dela vale quando o id repete.
 */
export const prateleiraDaPessoa = (config: string): string => `${dadosDe(config)}/prateleira`
