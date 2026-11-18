/**
 * De quanto em quanto tempo de silêncio do Codex o passo entrega um sinal de vida. O watchdog do Claude Code aborta
 * o subagente depois de 600 s sem chunk (e sem ferramenta em curso, o que um passo respondido por hook nunca tem):
 * o sinal de vida é chunk, enquanto o Codex vive.
 */
export const PULSE_MS = 60_000

/**
 * Silêncio que já não é trabalho: uma hora sem nenhum evento do Codex, folga sobre o comando longo de um build ou de
 * uma suíte de testes. Daí em diante a ponte encerra o Codex e relata; sem esse teto, o sinal de vida tiraria a
 * segurança do watchdog sem pôr outra no lugar.
 */
export const MAX_QUIET_MS = 60 * 60_000

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/** A linha do sinal de vida: há quanto tempo o Codex roda, há quanto está calado e o último andamento dele. */
export function pulseLine(elapsedMs: number, quietMs: number, latest?: string): string {
  return `[astra] Codex trabalhando há ${minutes(elapsedMs)} min; sem evento novo há ${minutes(quietMs)} min${latest ? `. Último: ${latest}` : ''}`
}
