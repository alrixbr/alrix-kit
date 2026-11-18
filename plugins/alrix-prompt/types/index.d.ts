/** O modo das mensagens: Normal passa direto, Organizar arruma o texto, Engenharia reestrutura o pedido. */
export type AlrixPromptMode = 'normal' | 'organizar' | 'engenharia'

/** Os dois modos que chamam o especialista (Sonnet 5.5). */
export type AlrixPromptExpert = 'organizar' | 'engenharia'

/**
 * A reescrita que está na caixa, esperando o dono revisar e mandar. `choice` diz o que vai no próximo envio: a
 * reescrita ou a original, que o dono pode trocar na faixa. `returned` é o texto que a engine devolve à caixa quando o
 * envio é descartado (a mensagem digitada, ou a linha do comando), e `isSettled` marca que ele já saiu de lá.
 */
export type AlrixPromptPending = {
  mode: AlrixPromptExpert
  original: string
  rewritten: string
  choice: 'reescrita' | 'original'
  returned: string
  isSettled: boolean
  /** O que falta no pedido e só o dono sabe, apontado pelo Engenharia: aparece na faixa e nunca vai para o agente. */
  gaps?: string[]
}

/** O especialista trabalhando agora, e há quantos segundos, para a faixa. */
export type AlrixPromptBusy = { mode: AlrixPromptExpert; seconds: number }

/** O que aconteceu com a última mensagem tratada, para a faixa e o painel de comparação. */
export type AlrixPromptLast = {
  mode: AlrixPromptExpert
  outcome: 'enviada' | 'na caixa' | 'revisada' | 'original' | 'descartada' | 'cancelada'
  ms: number
  tokensIn: number
  tokensOut: number
  note?: string
  original: string
  rewritten?: string
  /** As lacunas que o Engenharia apontou nesta chamada; some depois que o dono revisa e manda. */
  gaps?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'alrix-prompt': {
      /** O modo da sessão. Toda sessão começa em Normal; nada é lembrado de uma sessão para outra. */
      mode: AlrixPromptMode
      /** O modo só da próxima mensagem, por cima do da sessão; `null` quando não há. */
      once: Shaped<AlrixPromptMode | null>
      startedAt: number
      busy: Shaped<AlrixPromptBusy | null>
      pending: Shaped<AlrixPromptPending | null>
      last: Shaped<AlrixPromptLast | null>
    }
  }
}
