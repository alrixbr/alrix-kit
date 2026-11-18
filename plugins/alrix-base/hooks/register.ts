// alrix-base: o que o motor do Claude Code faz por dentro, sem abrir um programa a cada pedido.
//   1. classic.UserPromptSubmit: a data e a hora do relógio do computador entram junto de cada pedido.
//   2. classic.SessionStart, origem "compact": depois de uma compactação, os pedidos da pessoa e as respostas dela
//      na caixa de pergunta voltam ao contexto, lidos da transcrição da sessão.
// Os dois chamam `next` primeiro e somam o texto ao que os outros ganchos já deram. Nenhum pode travar a sessão:
// se um falha, o motor o pula e segue com o que veio de baixo (o `.catch` diz isso por escrito).
import type { Register } from 'claude-code'

import { pedidosDepoisDeCompactar } from './pedidos'
import { linhaDoRelogio } from './relogio'

/** A resposta dos ganchos de baixo com mais uma entrada de contexto. */
const comTexto = <R extends { additionalContext?: string[] }>(abaixo: R, texto: string): R => ({
  ...abaixo,
  additionalContext: [...(abaixo.additionalContext ?? []), texto],
})

export const register: Register = on => {
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const abaixo = await next(e)
    const agora = await $.clock.now()
    return comTexto(abaixo, linhaDoRelogio(new Date(agora)))
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', { source: 'compact' }, async ($, e, next) => {
    const abaixo = await next(e)
    const texto = await pedidosDepoisDeCompactar($, e.transcript_path, e.session_id)
    return texto === '' ? abaixo : comTexto(abaixo, texto)
  }).catch(($, e, next) => next(e))
}
