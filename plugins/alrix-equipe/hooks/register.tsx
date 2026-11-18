// alrix-equipe: só liga os eventos. O trabalho está em equipe.ts (ferramentas, porteiros, medição),
// codex.ts, ficha.ts, prateleira.ts, faixa.tsx (faixa de alertas e painel) e tela.tsx (o time na barra de estado
// ou sob o campo de texto).
import type { Register } from 'claude-code'

import {
  DESCRICOES,
  ESQUEMAS,
  PREFIXO,
  abrirComandoDoDono,
  anotarPorteiro,
  avisarTiposProntos,
  avisarFalha,
  conferirModeloNascido,
  contarNascido,
  decidirMensagem,
  decidirNascimento,
  decidirOferta,
  esforcoDoPasso,
  fecharComandoDoDono,
  fimDoNativo,
  lerConfig,
  liberarEsforco,
  liberarReserva,
  medir,
  notarAtividade,
  notarFerramenta,
  porteiroAgente,
  porteiroAprovados,
  porteiroDevolucao,
  porteiroEscrita,
  porteiroLeitura,
  porteiroShell,
  recarregarTime,
  registrarFim,
  registrarNascimento,
  responder,
  sondarOferta,
} from './equipe.ts'
import { guardarPedidoDono, lerTime } from './estado.ts'
import { PAINEL, TITULO, desenharFaixa, desenharPainel } from './faixa.tsx'
import { configurarTela, desenharDica, ligarPulso, pulsar } from './tela.tsx'

const GUARDADAS = ['montar', 'time', 'ampliar', 'dispensar', 'acionar', 'propor_licao', 'gravar_projeto', 'skills'] as const
const ESCRITA = new Set(['Edit', 'Write', 'NotebookEdit'])
const SHELL = new Set(['Bash', 'PowerShell'])
// as ferramentas de leitura: só a chave privada do SSH conta (porteiroLeitura)
const LEITURA = new Set(['Read', 'Grep', 'Glob'])
// A ferramenta com que o especialista entrega o relatório ao chefe. Os tipos desta versão só a citam num comentário
// interno (não a listam entre as ferramentas); por isso o nome é conferido como texto, e o diagnóstico do porteiro
// (avisos/<sessão>.jsonl, porteiro "devolucao") mostra ao vivo se o motor a entrega a este gancho.
const DEVOLUCAO = 'SubagentHandback'

export const register: Register = (on, options) => {
  const cfg = lerConfig(options)
  configurarTela(cfg.modo)

  // Abertura e recarga: as ferramentas, o comando e os tipos do time voltam a valer.
  // Desligado: nenhuma ferramenta nem comando, para o mod não ocupar contexto. Ligado: só o cardápio fica à
  // vista; as outras ficam atrás do ToolSearch, e o cardápio diz como carregá-las.
  on('session.start', async ($, e, next) => {
    if (cfg.modo === 'desligado') return next(e)
    await $.tool.register({ name: 'cardapio', description: DESCRICOES.cardapio, inputSchema: ESQUEMAS.cardapio, isDeferred: false })
    for (const nome of GUARDADAS) await $.tool.register({ name: nome, description: DESCRICOES[nome], inputSchema: ESQUEMAS[nome], isDeferred: true })
    await $.command.register({ name: 'equipe', description: 'Abre o painel do time de especialistas desta sessão.' })
    await recarregarTime($)
    ligarPulso($)
    return next(e)
  })

  on('command.run', { command: 'equipe' }, async $ => {
    await $.ui.open({ id: PAINEL, title: TITULO, closeOnEscape: true })
    return { text: 'Painel da equipe aberto.' }
  })

  // Um só tool.call: as ferramentas do mod, o porteiro de escrita e o de shell.
  on('tool.call', async ($, e, next) => {
    // A entrada e a volta da ferramenta de um ajudante são sinais de vida: um comando longo não tira ninguém da conta
    // do teto (notarFerramenta). A volta fica no finally: vale também para a recusa e para o erro.
    const quem = e.agentId
    if (quem === undefined) return porteiros()
    notarFerramenta(quem, await $.clock.now(), true)
    try {
      return await porteiros()
    } finally {
      notarFerramenta(quem, await $.clock.now().catch(() => Date.now()), false)
    }
    async function porteiros() {
    if (e.tool.startsWith(PREFIXO)) {
      const { tool: _t, tool_use_id: _i, agentId: _a, requestMeta: _m, ...input } = e as unknown as Record<string, unknown>
      const result = await responder($, cfg, e.tool.slice(PREFIXO.length), input, e.agentId)
      // montar, acionar e dispensar mudam quem roda: a tela confere na hora
      ligarPulso($)
      return { result }
    }
    const campos = e as unknown as Record<string, unknown>
    // A chamada do Agent, do chefe ou de um especialista: o esforço pedido passa pelo cartão (o nascimento não o traz).
    if (e.tool === 'Agent') {
      const recusa = await porteiroAgente($, cfg, campos, e.agentId)
      if (recusa !== undefined) return recusa
    }
    // As skills aprovadas só mudam pela ferramenta skills (o cartão da pessoa), para todos, o chefe incluído.
    if (ESCRITA.has(e.tool)) {
      const recusa = await porteiroAprovados($, cfg, e.tool === 'NotebookEdit' ? campos.notebook_path : campos.file_path)
      if (recusa !== undefined) return recusa
    }
    if (e.agentId === undefined) return next(e)
    // A devolução do especialista (T-12): conferida pelas partes do molde, volta uma vez se faltar parte. Um defeito aqui
    // deixa a devolução passar (o .catch abaixo não recusa o que não é escrita nem shell).
    if ((e.tool as string) === DEVOLUCAO) {
      const recusa = await porteiroDevolucao($, cfg, campos.message, e.agentId)
      return recusa ?? next(e)
    }
    if (ESCRITA.has(e.tool)) {
      const recusa = await porteiroEscrita($, cfg, e.tool, e.tool === 'NotebookEdit' ? campos.notebook_path : campos.file_path, e.agentId)
      return recusa ?? next(e)
    }
    if (SHELL.has(e.tool)) {
      const recusa = await porteiroShell($, cfg, e.tool, campos.command, e.agentId)
      return recusa ?? next(e)
    }
    if (LEITURA.has(e.tool)) {
      const recusa = await porteiroLeitura($, cfg, e.tool, campos, e.agentId)
      return recusa ?? next(e)
    }
    return next(e)
    }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    if (e.tool.startsWith(PREFIXO)) return { deny: `alrix-equipe: ${e.tool.slice(PREFIXO.length)} falhou antes de rodar; nada foi feito.` }
    if ((e.tool === 'Agent') && cfg.modo === 'barrar' && (e as unknown as Record<string, unknown>).effort !== undefined) {
      return { deny: 'alrix-equipe: o porteiro do esforço falhou e, no modo barrar, a chamada com "effort" fica recusada. Chame sem "effort".' }
    }
    if (e.agentId === undefined || cfg.modo === 'desligado' || (!ESCRITA.has(e.tool) && !SHELL.has(e.tool))) return next(e)
    // O território vale nos dois modos ligados: se o porteiro falha, a escrita ou o comando de quem é do time fica
    // recusado (passar seria gravar sem cerca). Sem conseguir ler o time, o modo barrar recusa e o aviso deixa passar,
    // porque no aviso um defeito do mod não para os ajudantes de fora do time.
    const agentId = e.agentId
    const doTime = await lerTime($)
      .then(time => time.some(x => x.agentIds.includes(agentId)))
      .catch(() => cfg.modo === 'barrar')
    return doTime ? { deny: 'alrix-equipe: o porteiro falhou, e a escrita ou o comando de um especialista fica recusado enquanto ele não confere o território. Pare e peça ao chefe.' } : next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const decisao = await decidirNascimento($, cfg, e)
    if ('deny' in decisao) return { deny: decisao.deny }
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(decisao.e)
    } catch (erro) {
      liberarReserva(decisao.reserva)
      throw erro
    }
    // Todo ajudante que o motor aceitou conta no teto até o fim da vez (o do chefe e o de workflow também); a vaga
    // reservada vira a dele. Recusado mais abaixo, a vaga volta.
    if (cfg.modo !== 'desligado' && 'agentId' in r && typeof r.agentId === 'string') {
      await contarNascido($, r.agentId, e.workflow !== undefined, decisao.reserva, e.fork ? 'fork' : e.subagentType).catch(() => undefined)
      liberarEsforco(e.tool_use_id, r.agentId)
    }
    else liberarReserva(decisao.reserva)
    // Ajudante sem modelo, no modo aviso: o caso só é anotado se o modelo em que ele nasceu não é o padrão.
    if (decisao.conferirModelo !== undefined && typeof r.model === 'string') await conferirModeloNascido($, decisao.conferirModelo, r.model).catch(() => undefined)
    if (decisao.especialista !== undefined && 'agentId' in r && typeof r.agentId === 'string') {
      await registrarNascimento($, decisao.especialista, r.agentId, decisao.ajudante === true, decisao.retrato).catch(() => undefined)
      ligarPulso($)
    } else if (cfg.modo !== 'desligado') {
      // um ajudante de fora do time pode ter virado caso anotado: a contagem da tela confere na hora
      void pulsar($).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) =>
    next.called || cfg.modo !== 'barrar' ? next(e) : { deny: 'alrix-equipe: o porteiro de ajudantes falhou; no modo barrar o nascimento fica recusado. Tente de novo.' },
  )

  on('agent.offer', async ($, e, next) => {
    // no modo aviso, a sonda anota a origem que o motor dá a cada tipo (para a prova ao vivo)
    await sondarOferta($, cfg, e.agent, e.source, e.provider).catch(() => undefined)
    return (await decidirOferta($, cfg, e.agent, e.source, e.provider.plugin)) === false ? { isOffered: false } : next(e)
  }).catch(async ($, e, next) => {
    // Deixa passar de propósito (um defeito do mod não pode parar os agentes), mas o chefe fica sabendo.
    await avisarFalha($, 'oferta de ajudantes', next.error).catch(() => undefined)
    return next(e)
  })

  // A conversa do time: o especialista fala com o chefe ("main") e com colegas que trabalham; o chefe chama
  // um especialista pelo nome. Outro destino de um especialista é recusado, com a saída dita.
  on('session.send', async ($, e, next) => {
    const d = await decidirMensagem($, cfg, e)
    if (!('recusa' in d)) return next(d.e)
    await anotarPorteiro($, 'mensagem', { decisao: 'recusado', de: e.agentId ?? 'chefe', para: e.to.slice(0, 80), motivo: d.recusa }).catch(() => undefined)
    return { isDelivered: false as const, reason: d.recusa }
  }).catch(async ($, e, next) => {
    // Deixa passar de propósito (um defeito do mod não pode parar os agentes), mas o chefe fica sabendo.
    await avisarFalha($, 'mensagens do time', next.error).catch(() => undefined)
    return next(e)
  })

  // As palavras do dono, as que ele mesmo escreveu, para conferir o pedido do Fable na ficha. E a janela dos comandos
  // do dono (opção comandosDoDono em "liberar"): abre quando o dono manda um comando que chama o modelo (o prompt.submit
  // dele traz `command`; um comando local, como /context, não chama o modelo nem abre a janela) e fecha em qualquer outra
  // entrada: a mensagem comum dele, a notificação de um ajudante, a mensagem de outra sessão, a tarefa agendada.
  on('prompt.submit', async ($, e, next) => {
    if (cfg.modo !== 'desligado') {
      const doDono = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      if (doDono && e.command !== undefined && cfg.comandosDoDono === 'liberar') abrirComandoDoDono(e.command.name, await $.clock.now())
      else fecharComandoDoDono()
      if (doDono && e.command === undefined && e.text.trim() !== '') await guardarPedidoDono($, e.text).catch(() => undefined)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    // Deixa passar de propósito (um defeito do mod não pode parar os agentes), mas o chefe fica sabendo.
    await avisarFalha($, 'palavras do dono (pedido do Fable)', next.error).catch(() => undefined)
    return next(e)
  })

  // Medição: os tokens de entrada da primeira resposta de cada especialista.
  // `yield* next(e)` repassa a resposta do modelo sem tocar nela e devolve o resultado: a sessão principal
  // passa direto, e só a primeira resposta de um especialista é medida.
  // O esforço de cada passo de um ajudante: anotado no primeiro passo e, no modo barrar, rebaixado para alto em quem não
  // é especialista e não passou pelo cartão (esforcoDoPasso).
  on('turn.step', async function* ($, e, next) {
    let passo = e
    if (e.agentId !== undefined && cfg.modo !== 'desligado') {
      const novo = await esforcoDoPasso($, cfg, e.agentId, e.effort).catch(() => undefined)
      if (novo !== undefined) passo = { ...e, effort: novo }
    }
    const r = yield* next(passo)
    // um passo do modelo: o ajudante está vivo (a conta do teto tira quem fica 30 min calado)
    if (e.agentId !== undefined) notarAtividade(e.agentId, await $.clock.now())
    if (e.agentId !== undefined && r.usage !== null) {
      try {
        await medir($, e.agentId, r.usage)
      } catch {
        /* a medida perdida não muda a resposta */
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      // o Codex nativo: o que ele gravou sozinho, o limite e o molde, conferidos antes de ele sair dos que rodam
      if (cfg.modo !== 'desligado') await fimDoNativo($, e.agentId, e.answer).catch(() => undefined)
      await registrarFim($, e.agentId).catch(() => undefined)
      await pulsar($).catch(() => undefined)
    }
    // Fim de um turno do chefe: a resposta ao comando do dono acabou; se montar registrou tipos, o aviso que abre o
    // turno seguinte sai agora.
    else if (cfg.modo !== 'desligado') {
      fecharComandoDoDono()
      await avisarTiposProntos($, e.isAborted).catch(() => undefined)
    }
    return r
  })

  // A tela do dono. Cada desenho que falha deixa o do motor no lugar: next(e) é o que ele desenharia.
  // O modo do mod vai na própria linha da Equipe, e não nos rótulos do rodapé: tudo do mod num lugar só.
  // Onde uma barra de estado desenha o time, esta linha fica como o motor a desenha (tela.tsx).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => (cfg.modo === 'desligado' ? next(e) : desenharDica($, e, next, cfg.modo))).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (cfg.modo === 'desligado' ? next(e) : desenharFaixa($, e, next))).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'equipe' }, async ($, e) => desenharPainel($, e, cfg.modo, cfg.teto))
}
