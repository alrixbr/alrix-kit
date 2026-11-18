// Capacidade: memória livre da máquina (guardada por 60 s) e vagas do time.
import type { EngineInterface } from 'claude-code'

import type { EquipeEspecialista } from '../types'
import { gravarMemoria, lerMemoria } from './estado.ts'

export const MEMORIA_GUARDA_MS = 60_000

/** GB livres a partir de /proc/meminfo (linha MemAvailable, em kB); null quando a linha não está lá. */
export function gbDoMeminfo(texto: string): number | null {
  const achado = /^MemAvailable:\s+(\d+)\s*kB/m.exec(texto)
  return achado?.[1] === undefined ? null : Number(achado[1]) / 1024 / 1024
}

/** GB livres a partir da saída de FreePhysicalMemory (em KB); null quando não é um número. */
export function gbDoWindows(saida: string): number | null {
  const linha = saida.trim().split(/\r?\n/).find(l => /^\d+$/.test(l.trim()))
  return linha === undefined ? null : Number(linha.trim()) / 1024 / 1024
}

/**
 * A memória livre em GB, ou null quando não pôde ser lida. Linux: /proc/meminfo. Windows: o
 * FreePhysicalMemory do Win32_OperatingSystem. A leitura vale por 60 s.
 */
export async function memoriaLivreGb($: EngineInterface, windows: boolean): Promise<number | null> {
  const agora = await $.clock.now()
  const guardada = await lerMemoria($)
  if (guardada.lidoEm > 0 && agora >= guardada.lidoEm && agora - guardada.lidoEm < MEMORIA_GUARDA_MS) return guardada.gb
  let gb: number | null = null
  try {
    if (windows) {
      const r = await $.process.run(['powershell.exe', '-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { timeoutMs: 20_000 })
      gb = r.exitCode === 0 ? gbDoWindows(r.stdout) : null
    } else {
      gb = gbDoMeminfo(String(await $.fs.read('/proc/meminfo')))
    }
  } catch {
    gb = null
  }
  await gravarMemoria($, { gb, lidoEm: agora })
  return gb
}

/** Especialistas que ainda contam no time (os dispensados saem). */
export const vivos = (time: readonly EquipeEspecialista[]): EquipeEspecialista[] => time.filter(x => x.estado !== 'dispensado')

/** Quantos rodam agora: ajudantes do Claude em execução e execuções do Codex que não acabaram. */
export const rodando = (time: readonly EquipeEspecialista[]): number =>
  time.reduce(
    (soma, x) => soma + x.emExecucao.length + (x.codex?.execucoes.filter(c => c.fase === 'iniciando' || c.fase === 'rodando').length ?? 0),
    0,
  )

/** Vagas no time: o teto menos os vivos. */
export const vagas = (time: readonly EquipeEspecialista[], teto: number): number => Math.max(0, teto - vivos(time).length)
