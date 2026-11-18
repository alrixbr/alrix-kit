// As ferramentas que gravam na prateleira da pessoa: gravar_projeto (a ficha de um projeto, conferida antes de gravar)
// e skills (lista as skills instaladas e aprova as que a pessoa confirmar no cartão, com a impressão digital).
// Só o chefe as usa (responder, em equipe.ts). Nada aqui grava fora de <pasta do Claude Code>/alrix-equipe/prateleira.
import type { EngineInterface } from 'claude-code'

import type { Aprovado, Projeto, Regra } from './contrato.ts'
import { hojeIso } from './ficha.ts'
import { casaDe, configDe } from './pastas.ts'
import { ESTA_PASTA, ID, ID_SKILL, PREFIXO_PESSOA, arquivosDaPrateleira, esquecerPrateleira, impressaoDigital, montarPrateleira, prateleiraAgora } from './prateleira.ts'
import { ehAbsoluto } from './territorio.ts'

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [])
const barras = (v: string): string => v.replace(/\\/g, '/').replace(/\/+$/, '')

// ------------------------------------------------------------------------------------- gravar_projeto

/** A ficha do projeto como vai para o arquivo, só com os campos preenchidos. */
export function projetoDoPedido(input: Record<string, unknown>, pasta: string, hoje: string): Projeto {
  const regras: Regra[] = Array.isArray(input.regras)
    ? (input.regras as unknown[]).flatMap(r => {
        if (typeof r !== 'object' || r === null) return [{ regra: '', motivo: '' }]
        const o = r as Record<string, unknown>
        return [{ regra: texto(o.regra), motivo: texto(o.motivo), ...(texto(o.escopo) ? { escopo: texto(o.escopo) } : {}) }]
      })
    : []
  const pc: NonNullable<Projeto['pc']> = { pasta }
  if (texto(input.repositorio)) pc.repositorio = texto(input.repositorio)
  if (texto(input.ramoPrincipal)) pc.ramoPrincipal = texto(input.ramoPrincipal)
  if (lista(input.comoRodar).length) pc.comoRodar = lista(input.comoRodar)
  if (lista(input.comoTestar).length) pc.comoTestar = lista(input.comoTestar)
  return {
    id: texto(input.id),
    nome: texto(input.nome),
    resumo: texto(input.resumo),
    conferidoEm: hoje,
    pc,
    ...(lista(input.stack).length ? { stack: lista(input.stack) } : {}),
    ...(lista(input.arquivosDeVersao).length ? { arquivosDeVersao: lista(input.arquivosDeVersao) } : {}),
    naoToque: lista(input.naoToque),
    regras,
    ...(lista(input.kitsSugeridos).length ? { kitsSugeridos: lista(input.kitsSugeridos) } : {}),
  }
}

/**
 * Grava a ficha de um projeto na prateleira da pessoa, depois da mesma conferência que a prateleira passa ao carregar
 * (campos, regras com motivo, kits que existem) e mais: a pasta existe neste computador. Um projeto que a pessoa já
 * gravou com o mesmo id só é trocado com `substituir`, e o anterior fica em <id>.json.anterior.
 */
export async function gravarProjeto($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const id = texto(input.id)
  const recusa = (motivos: string[]): string => ['gravar_projeto recusou. Nada foi gravado. Corrija e chame de novo:', ...motivos.map(m => `- ${m}`)].join('\n')
  if (!ID.test(id)) return recusa(['id: use só minúsculas, dígitos e hífen (ex.: "meu-site")'])
  if (id === ESTA_PASTA) return recusa([`id: "${ESTA_PASTA}" é o da pasta da sessão, que o mod já oferece; escolha outro`])
  const pedida = texto(input.pasta)
  const pasta = barras(pedida || (await $.session.cwd()))
  if (!ehAbsoluto(pasta)) return recusa([`pasta: "${pedida}" não é um caminho absoluto deste computador`])
  const st = await $.fs.stat(pasta).catch(() => undefined)
  if (st?.kind !== 'dir') return recusa([`pasta: ${pasta} não existe neste computador, ou não é uma pasta`])

  const projeto = projetoDoPedido(input, pasta, hojeIso(await $.clock.now()))
  const { arquivos, pastaPessoa } = await arquivosDaPrateleira($)
  const chave = `${PREFIXO_PESSOA}projetos/${id}.json`
  const anterior = arquivos[chave]
  if (anterior !== undefined && input.substituir !== true) {
    return recusa([`a prateleira da pessoa já tem o projeto "${id}" (${pastaPessoa}/projetos/${id}.json); chame com substituir: true para trocá-lo, ou use outro id`])
  }
  const conteudo = `${JSON.stringify(projeto, null, 2)}\n`
  const { problemas } = montarPrateleira({ ...arquivos, [chave]: conteudo })
  const deste = problemas.filter(p => p.startsWith(chave)).map(p => p.slice(chave.length).replace(/^:\s*/, ''))
  if (deste.length) return recusa(deste)

  const caminho = `${pastaPessoa}/projetos/${id}.json`
  if (anterior !== undefined) await $.fs.write(`${caminho}.anterior`, anterior)
  await $.fs.write(caminho, conteudo)
  esquecerPrateleira()
  const outros = problemas.filter(p => !p.startsWith(chave))
  return [
    `Projeto ${id} gravado em ${caminho}${anterior !== undefined ? ` (o anterior ficou em ${caminho}.anterior)` : ''}.`,
    `Ele já está no cardápio: use projeto "${id}" na ficha, e cada especialista dele nasce com a pasta, ${projeto.pc?.comoTestar?.length ? 'como testar, ' : ''}o que não tocar e as ${projeto.regras.length} regras com motivo.`,
    ...(projeto.pc?.comoTestar?.length ? [] : ['A ficha não diz como testar: grave de novo com comoTestar quando souber, para o especialista provar o que fez.']),
    ...(outros.length ? ['A prateleira tem outros problemas, e montar recusa até corrigir:', ...outros.map(p => `- ${p.startsWith(PREFIXO_PESSOA) ? `${pastaPessoa}/${p.slice(PREFIXO_PESSOA.length)}` : p}`)] : []),
  ].join('\n')
}

// --------------------------------------------------------------------------------------------- skills

/** Uma skill instalada neste computador, com o arquivo de onde o Claude Code a carrega. */
export type SkillInstalada = { nome: string; origem: string; fonte: string; descricao: string; texto: string }

/** O nome e a descrição do cabeçalho de um SKILL.md (só a primeira linha de cada campo). */
export function cabecalhoDaSkill(conteudo: string): { nome?: string; descricao?: string } {
  const cabecalho = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(conteudo)?.[1] ?? ''
  const campo = (nome: string): string | undefined => {
    const valor = new RegExp(`^${nome}:\\s*(.*)$`, 'm').exec(cabecalho)?.[1]?.trim().replace(/^["']|["']$/g, '')
    return valor === undefined || valor === '' || valor === '|' || valor === '>' ? undefined : valor
  }
  const nome = campo('name')
  const descricao = campo('description')
  return { ...(nome ? { nome } : {}), ...(descricao ? { descricao } : {}) }
}

/** As skills de uma pasta "skills" (uma subpasta por skill, com o SKILL.md dentro). */
async function skillsDaPasta($: EngineInterface, pasta: string, fonte: string, plugin?: string): Promise<SkillInstalada[]> {
  let entradas: { name: string; kind: string }[] = []
  try {
    entradas = await $.fs.list(pasta)
  } catch {
    return []
  }
  const achadas: SkillInstalada[] = []
  for (const e of entradas) {
    if (e.kind !== 'dir') continue
    const origem = `${pasta}/${e.name}/SKILL.md`
    let conteudo: string
    try {
      conteudo = String(await $.fs.read(origem))
    } catch {
      continue
    }
    const cab = cabecalhoDaSkill(conteudo)
    const base = cab.nome ?? e.name
    achadas.push({ nome: plugin === undefined ? base : `${plugin}:${base}`, origem, fonte, descricao: cab.descricao ?? '', texto: conteudo })
  }
  return achadas
}

/**
 * As skills instaladas: as pessoais (<pasta do Claude Code>/skills) e as dos plugins instalados (a pasta skills de
 * cada instalação que o plugins/installed_plugins.json do Claude Code lista). Um plugin carregado de outro jeito
 * (pasta de desenvolvimento) não entra.
 */
export async function skillsInstaladas($: EngineInterface): Promise<SkillInstalada[]> {
  const config = await configDe($)
  const todas = await skillsDaPasta($, `${config}/skills`, 'pessoal')
  try {
    const instalados = JSON.parse(String(await $.fs.read(`${config}/plugins/installed_plugins.json`))) as { plugins?: Record<string, { installPath?: unknown }[]> }
    for (const [chave, entradas] of Object.entries(instalados.plugins ?? {})) {
      const plugin = chave.split('@')[0] ?? chave
      const vistos = new Set<string>()
      for (const entrada of Array.isArray(entradas) ? entradas : []) {
        if (typeof entrada?.installPath !== 'string') continue
        const pasta = barras(entrada.installPath)
        if (vistos.has(pasta)) continue
        vistos.add(pasta)
        todas.push(...(await skillsDaPasta($, `${pasta}/skills`, `plugin ${plugin}`, plugin)))
      }
    }
  } catch {
    /* sem a lista de plugins instalados, ficam as pessoais */
  }
  const unicas = new Map<string, SkillInstalada>()
  for (const s of todas) if (!unicas.has(s.nome)) unicas.set(s.nome, s)
  return [...unicas.values()].sort((a, b) => a.nome.localeCompare(b.nome))
}

const curto = (v: string, max: number): string => {
  const limpo = v.replace(/\s+/g, ' ').trim()
  return limpo.length > max ? `${limpo.slice(0, max - 1).trimEnd()}…` : limpo
}

/** O caminho como vai para aprovados.json: "~/..." quando fica na pasta do usuário, para a prateleira não levar o nome dele. */
const caminhoGuardado = (origem: string, casa: string): string => {
  const o = barras(origem)
  return o.toLowerCase().startsWith(`${casa.toLowerCase()}/`) ? `~/${o.slice(casa.length + 1)}` : o
}

/**
 * A ferramenta skills. Sem "aprovar": as skills instaladas, cada uma marcada como aprovada, aprovada mas mudada desde
 * então, ou não aprovada. Com "aprovar": um cartão à pessoa com as skills pedidas; só com "Aprovar" elas entram em
 * <prateleira da pessoa>/aprovados.json, com a impressão digital e o tamanho de agora.
 */
export async function skills($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const instaladas = await skillsInstaladas($)
  const casa = await casaDe($)
  const { arquivos, pastaPessoa } = await arquivosDaPrateleira($)
  const caminhoAprovados = `${pastaPessoa}/aprovados.json`
  const bruto = arquivos[`${PREFIXO_PESSOA}aprovados.json`]
  let daPessoa: Aprovado[] = []
  if (bruto !== undefined) {
    try {
      const lido = JSON.parse(bruto.replace(/^﻿/, '')) as { aprovados?: unknown }
      daPessoa = Array.isArray(lido.aprovados) ? (lido.aprovados as Aprovado[]) : []
    } catch {
      return `skills recusou: ${caminhoAprovados} não é um JSON válido, e o mod não o sobrescreve. Peça à pessoa para corrigir ou apagar o arquivo.`
    }
  }
  const { prateleira } = await prateleiraAgora($, true)
  const valendo = new Set(prateleira.aprovados.map(a => a.id))
  const aprovadaAntes = new Set([...daPessoa.map(a => a.id), ...valendo])

  const pedidos = Array.isArray(input.aprovar) ? (input.aprovar as unknown[]).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []
  if (pedidos.length === 0) {
    if (instaladas.length === 0) return 'Não achei skills instaladas: nem na pasta skills da configuração do Claude Code, nem nos plugins instalados.'
    const linhas = [`Skills instaladas (${instaladas.length}). Para aprovar, chame skills com aprovar: [{ nome, quandoUsar }]; a pessoa confirma num cartão.`]
    for (const s of instaladas) {
      const situacao = valendo.has(s.nome) ? 'aprovada' : aprovadaAntes.has(s.nome) ? 'aprovada, mas mudou ou sumiu desde então: precisa de nova aprovação' : ID_SKILL.test(s.nome) ? 'não aprovada' : 'não pode ser aprovada: o nome tem maiúscula ou sinal fora de letras, dígitos e hífen'
      linhas.push(`- ${s.nome} (${s.fonte}, ${s.texto.length} caracteres): ${situacao}.${s.descricao ? ` ${curto(s.descricao, 160)}` : ''}`)
    }
    return linhas.join('\n')
  }

  const escolhidas: { s: SkillInstalada; quandoUsar: string }[] = []
  const erros: string[] = []
  for (const p of pedidos.slice(0, 10)) {
    const nome = texto(p.nome)
    const s = instaladas.find(x => x.nome === nome)
    if (s === undefined) erros.push(`"${nome}" não está entre as skills instaladas (chame skills sem argumentos para ver a lista)`)
    else if (!ID_SKILL.test(s.nome)) erros.push(`"${nome}" tem maiúscula ou sinal fora de letras, dígitos e hífen, e o mod não a carrega por esse nome`)
    else escolhidas.push({ s, quandoUsar: texto(p.quandoUsar) || s.descricao || 'Quando a tarefa pede o que a skill descreve.' })
  }
  if (pedidos.length > 10) erros.push('o cartão leva até 10 skills de cada vez; peça as outras numa segunda chamada')
  if (escolhidas.length === 0) return ['skills: nada foi aprovado.', ...erros.map(e => `- ${e}`)].join('\n')

  const pergunta = [
    `O agente pede que os especialistas do time possam usar ${escolhidas.length === 1 ? 'esta skill' : `estas ${escolhidas.length} skills`}:`,
    ...escolhidas.map(({ s, quandoUsar }) => `- ${s.nome} (${s.fonte === 'pessoal' ? 'sua' : `do ${s.fonte}`}): ${curto(quandoUsar, 140)}`),
    'Se você aprovar, elas entram na sua prateleira com a impressão digital de hoje. Se o arquivo de uma delas mudar depois, ela sai dos especialistas até você aprovar de novo.',
    'Aprovar?',
  ].join('\n')
  const resposta = await $.ui.ask(pergunta, { options: ['Aprovar', 'Não'], header: 'Skills' }).catch(() => 'Não')
  if (resposta !== 'Aprovar') return `A pessoa não aprovou${resposta === 'Não' ? '' : ` (respondeu: ${curto(resposta, 200)})`}. Nada foi gravado.`

  const lote = `pessoa-${hojeIso(await $.clock.now())}`
  let novos = [...daPessoa]
  for (const { s, quandoUsar } of escolhidas) {
    const aprovado: Aprovado = {
      id: s.nome,
      tipo: 'skill',
      nome: s.nome,
      origem: caminhoGuardado(s.origem, casa),
      versao: await impressaoDigital(s.texto),
      peso: s.texto.length,
      quandoUsar,
      lote,
    }
    novos = novos.some(a => a.id === aprovado.id) ? novos.map(a => (a.id === aprovado.id ? aprovado : a)) : [...novos, aprovado]
  }
  if (bruto !== undefined) await $.fs.write(`${caminhoAprovados}.anterior`, bruto)
  await $.fs.write(caminhoAprovados, `${JSON.stringify({ aprovados: novos }, null, 2)}\n`)
  esquecerPrateleira()
  return [
    `Aprovado pela pessoa: ${escolhidas.map(e => e.s.nome).join(', ')}. Gravado em ${caminhoAprovados}.`,
    'Use no campo "skills" da ficha; o especialista nasce com elas carregadas.',
    ...(erros.length ? ['Ficaram de fora:', ...erros.map(e => `- ${e}`)] : []),
  ].join('\n')
}
