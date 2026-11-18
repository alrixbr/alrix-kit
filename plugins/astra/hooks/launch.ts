/**
 * Com que agente este processo do Claude Code foi lançado. `type` vem de `--agent X` ou `--agent=X` (sessão
 * aberta com o perfil) ou de `--agent-type X` num teammate em painel tmux próprio, que o Claude Code lança com
 * `--agent-id`, `--agent-name` e `--team-name`; sem a equipe, o Claude Code ignora `--agent-type`, e o mod também.
 * O argv só dá o ponto de partida do `type`, e o mod só o usa com o nome completo (`astra:sol`): o nome curto é o
 * Claude Code quem resolve, e a cada pedido vale o agente que ele resolveu (register.ts).
 */
export type Launch = { type?: string; name?: string; team?: string }

/** O argv do processo, lido de `/proc/self/cmdline`: os argumentos vêm separados por NUL. */
export function argvOf(cmdline: string): string[] {
  return cmdline.split('\0').filter(part => part !== '')
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (const [position, part] of argv.entries()) {
    if (part === flag) return argv[position + 1]
    if (part.startsWith(`${flag}=`)) return part.slice(flag.length + 1)
  }
  return undefined
}

export function parseLaunch(argv: readonly string[]): Launch {
  const team = flagValue(argv, '--team-name')
  const type = flagValue(argv, '--agent') ?? (team === undefined ? undefined : flagValue(argv, '--agent-type'))
  return { type, name: flagValue(argv, '--agent-name'), team }
}
