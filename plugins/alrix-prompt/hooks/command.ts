import type { CommandRunResult, EngineInterface } from 'claude-code'

import type { AlrixPromptExpert, AlrixPromptMode } from '../types'
import { armOnce, chooseMode, readNext } from './state'

// `/modo` troca o modo da sessão; `/organizar` e `/engenharia` valem só para a próxima mensagem (com um texto depois,
// para aquele texto: o prompt.submit do submit.ts o trata antes de o comando rodar). Os nomes vão por extenso aqui e
// nos matchers do register.tsx, para o scan da engine ler que o mod responde aos próprios comandos.

const BY_ARGUMENT: Record<string, AlrixPromptMode> = {
  '1': 'normal',
  normal: 'normal',
  '2': 'organizar',
  organizar: 'organizar',
  '3': 'engenharia',
  engenharia: 'engenharia',
}

const CYCLE: Record<AlrixPromptMode, AlrixPromptMode> = { normal: 'organizar', organizar: 'engenharia', engenharia: 'normal' }

export async function registerCommands($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'modo',
    description: 'alrix-prompt: o modo das suas mensagens nesta sessão (1 Normal, 2 Organizar, 3 Engenharia); sem argumento, vai para o próximo',
    argumentHint: '[1|2|3]',
    immediate: true,
  })
  await $.command.register({
    name: 'organizar',
    description: 'alrix-prompt: arruma a escrita só da próxima mensagem, sem mudar o que você pediu (com um texto depois, só desse texto)',
    argumentHint: '[texto]',
    immediate: true,
  })
  await $.command.register({
    name: 'engenharia',
    description: 'alrix-prompt: reestrutura só a próxima mensagem como um pedido completo, para você revisar (com um texto depois, só desse texto)',
    argumentHint: '[texto]',
    immediate: true,
  })
}

export async function runModo($: EngineInterface, args: string): Promise<CommandRunResult> {
  const typed = args.trim().toLowerCase()
  const wanted = typed === '' ? CYCLE[(await readNext($)).mode] : BY_ARGUMENT[typed]
  if (wanted === undefined) return { text: 'Use /modo 1, 2 ou 3 (Normal, Organizar, Engenharia), ou /modo sozinho para ir ao próximo.' }
  await chooseMode($, wanted)
  return {}
}

/** Só a próxima mensagem. Com um texto que o prompt.submit não tratou (curto, ou vindo de fora), ele vai para a caixa. */
export async function runOnce($: EngineInterface, expert: AlrixPromptExpert, args: string): Promise<CommandRunResult> {
  await armOnce($, expert)
  const text = args.trim()
  if (text !== '') await $.prompt.fill({ text })
  return {}
}
