// ALRIX · prompt: os três modos das mensagens do dono, desligados até ele querer.
// - Normal passa direto. Toda sessão começa nele; nada é lembrado de uma sessão para outra.
// - Organizar: o Sonnet 5.5 arruma a escrita (grafia, acento, pontuação, parágrafo) sem mudar palavras nem pedido, e a
//   mensagem segue.
// - Engenharia: o Sonnet 5.5 reestrutura o pedido para o agente (objetivo, contexto, restrições, pronto), e a versão
//   volta para a caixa para o dono revisar; a original vai junto, invisível, como âncora.
// Liga pela faixa acima do prompt (clique, ou ctrl+x tab e 1, 2 ou 3: o primeiro toque vale só para a próxima
// mensagem, o segundo mantém na sessão, o terceiro desliga), por /organizar e /engenharia (só a próxima, ou só o texto
// que vier depois) e por /modo (a sessão). As travas, a entrada e a âncora ficam em core.ts, as mesmas do ALRIX Code.
import type { Register } from 'claude-code'

import { renderBand } from './band'
import { registerCommands, runModo, runOnce } from './command'
import { renderPane } from './pane'
import { holdPending, resetSession, startSession } from './state'
import { onSubmit, settleBox } from './submit'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await startSession($)
    await registerCommands($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetSession($)
    else await holdPending($, null)
    return next(e)
  })

  on('command.run', { command: 'modo' }, ($, e) => runModo($, e.args))
  on('command.run', { command: 'organizar' }, ($, e) => runOnce($, 'organizar', e.args))
  on('command.run', { command: 'engenharia' }, ($, e) => runOnce($, 'engenharia', e.args))

  // Se o mod falhar antes de chamar `next`, a mensagem segue como o dono digitou; depois, vale o que `next` deu.
  on('prompt.submit', onSubmit).catch(($, e, next) => next(e))

  on('prompt.change', { origin: { kind: 'engine' } }, async ($, e, next) => {
    const result = await next(e)
    await settleBox($, e.text)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, renderBand)
  on('ui.render', { component: 'Pane', requestId: 'alrix-prompt' }, renderPane)
}
