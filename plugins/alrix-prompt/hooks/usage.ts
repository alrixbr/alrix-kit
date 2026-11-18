// O registro de uso: uma linha por mensagem tratada, sem o texto dela, para medir o mod com o uso de verdade (quanto é
// descartado e por quê, quantas vezes o dono troca pela original, quanto demora). Um arquivo por sessão, em
// ~/.claude/alrix-prompt/uso/<sessão>.jsonl; `node eval/uso.ts` soma todos. ALRIX_PROMPT_REGISTRO=0 desliga.
// Falhar aqui nunca segura a mensagem.
import type { EngineInterface } from 'claude-code'

import type { AlrixPromptLast } from '../types'

export type UseLine = {
  em: string
  modo: AlrixPromptLast['mode']
  resultado: AlrixPromptLast['outcome']
  motivo?: string
  ms: number
  tokensIn: number
  tokensOut: number
  /** Só os tamanhos, em caracteres: o texto não é gravado. */
  original: number
  reescrita?: number
  /** Quantas lacunas o Engenharia apontou nesta chamada (só a contagem). */
  lacunas?: number
}

/**
 * O tipo do motivo de um descarte, sem o pedaço da mensagem que o aviso na tela mostra ("perdeu /root/x" vira
 * "perdeu um item técnico").
 */
export function reasonKind(note: string): string {
  if (note.startsWith('perdeu a ênfase')) return 'perdeu a ênfase'
  if (note.startsWith('perdeu uma negação')) return 'perdeu uma negação'
  if (note.startsWith('perdeu ')) return 'perdeu um item técnico'
  if (note.startsWith('inventou ')) return 'inventou'
  if (note.startsWith('pôs ênfase')) return 'pôs ênfase'
  if (note.startsWith('erro da API')) return note.split(' ').slice(0, 4).join(' ')
  return note
}

export const useLineOf = (now: number, done: AlrixPromptLast): UseLine => ({
  em: new Date(now).toISOString(),
  modo: done.mode,
  resultado: done.outcome,
  ...(done.note === undefined ? {} : { motivo: reasonKind(done.note) }),
  ms: done.ms,
  tokensIn: done.tokensIn,
  tokensOut: done.tokensOut,
  original: done.original.length,
  ...(done.rewritten === undefined ? {} : { reescrita: done.rewritten.length }),
  ...(done.gaps === undefined ? {} : { lacunas: done.gaps.length }),
})

async function fileOf($: EngineInterface): Promise<string | undefined> {
  if ((await $.env.get('ALRIX_PROMPT_REGISTRO')) === '0') return undefined
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home === undefined || home === '') return undefined
  return `${home.replace(/\\/g, '/')}/.claude/alrix-prompt/uso/${await $.session.id()}.jsonl`
}

/** Acrescenta a linha desta mensagem ao arquivo da sessão. */
export async function logUse($: EngineInterface, done: AlrixPromptLast): Promise<void> {
  try {
    const path = await fileOf($)
    if (path === undefined) return
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    await $.fs.write(path, `${before}${JSON.stringify(useLineOf(await $.clock.now(), done))}\n`)
  } catch {
    // O registro é só medida: sem disco, sem pasta ou sem sessão, a mensagem segue igual.
  }
}
