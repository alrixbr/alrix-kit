// A prateleira: projetos, tipos de trabalho, kits, skills aprovadas, lições, motores e regras da casa. Vem de duas
// fontes: a do plugin (prateleira/, dentro do mod) e a da pessoa (<pasta do Claude Code>/alrix-equipe/prateleira),
// que soma à do plugin e vale quando o id repete. `montarPrateleira` e `textoCardapio` são puros; `carregar` lê os
// arquivos, confere a impressão digital das skills aprovadas e junta a pasta da sessão como projeto.
import type { EngineInterface } from 'claude-code'

import type { Aprovado, Casa, Kit, Licao, Motor, Prateleira, Projeto, Regra, TipoTrabalho } from './contrato.ts'
import { ESFORCOS_COM_CARTAO, ESFORCOS_DO_AGENTE, hojeIso, usoDoModelo } from './ficha.ts'
import { casaDe, configDe, prateleiraDaPessoa } from './pastas.ts'
import { comandoRecusado } from './territorio.ts'

const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const ID = /^[a-z0-9][a-z0-9-]*$/
/** O id de uma skill aprovada é o nome com que o Claude Code a carrega: "nome" ou "plugin:nome". */
export const ID_SKILL = /^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/

/** Onde os arquivos da prateleira da pessoa entram no mapa de `montarPrateleira` ("pessoa/projetos/x.json"). */
export const PREFIXO_PESSOA = 'pessoa/'

/** O projeto que toda sessão tem sem arquivo nenhum: a pasta em que ela foi aberta. */
export const ESTA_PASTA = 'esta-pasta'

type Json = Record<string, unknown>

const objeto = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const texto = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const textos = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** Regras com regra e motivo; devolve os problemas encontrados. */
export function conferirRegras(onde: string, v: unknown, problemas: string[]): v is Regra[] {
  if (!Array.isArray(v)) {
    problemas.push(`${onde}: falta a lista de regras`)
    return false
  }
  v.forEach((r, i) => {
    if (!objeto(r) || !texto(r.regra) || !texto(r.motivo)) problemas.push(`${onde}[${i}]: toda regra tem "regra" e "motivo"`)
  })
  return true
}

/** O JSON de um arquivo da prateleira. O da pessoa é opcional: ausente, não é problema. */
function lerJson(arquivos: Record<string, string>, caminho: string, problemas: string[], obrigatorio = true): unknown {
  const bruto = arquivos[caminho]
  if (bruto === undefined) {
    if (obrigatorio) problemas.push(`${caminho}: arquivo ausente`)
    return undefined
  }
  try {
    return JSON.parse(bruto.replace(/^﻿/, ''))
  } catch (erro) {
    problemas.push(`${caminho}: JSON inválido (${String((erro as Error)?.message ?? erro).slice(0, 120)})`)
    return undefined
  }
}

const faltam = (onde: string, obj: Json, campos: string[], problemas: string[]): boolean => {
  const ausentes = campos.filter(c => !texto(obj[c]))
  if (ausentes.length) problemas.push(`${onde}: faltam ${ausentes.join(', ')}`)
  return ausentes.length > 0
}

/** As duas fontes, na ordem em que se somam: a do plugin, obrigatória, e a da pessoa por cima. */
const FONTES = [
  { prefixo: 'prateleira/', pessoa: false, rotulo: '' },
  { prefixo: PREFIXO_PESSOA, pessoa: true, rotulo: ' (prateleira da pessoa)' },
] as const

/** Junta duas listas pelo id: o item de `porCima` toma o lugar do de `base` com o mesmo id, na mesma posição. */
export function juntarPorId<T extends { id: string }>(base: readonly T[], porCima: readonly T[]): T[] {
  const junto = [...base]
  for (const item of porCima) {
    const i = junto.findIndex(x => x.id === item.id)
    if (i >= 0) junto[i] = item
    else junto.push(item)
  }
  return junto
}

/**
 * Monta a prateleira a partir do texto de cada arquivo, pelo caminho relativo: os do plugin como
 * "prateleira/casa.json", "prateleira/projetos/x.json"; os da pessoa como "pessoa/casa.json", "pessoa/projetos/x.json".
 * Os da pessoa são opcionais, somam aos do plugin e valem quando o id repete (a casa.json dela soma as listas).
 * Confere os campos obrigatórios e as referências cruzadas sobre o que ficou junto; o que não passa fica fora, com o
 * problema dito. motores.json e devolucao.md só valem os do plugin.
 */
export function montarPrateleira(arquivos: Record<string, string>): { prateleira: Prateleira; problemas: string[] } {
  const problemas: string[] = []

  const unicos = (nome: string, ids: string[], molde = ID): void => {
    const vistos = new Set<string>()
    for (const id of ids) {
      if (!molde.test(id)) {
        const forma = molde === ID ? 'só minúsculas, dígitos e hífen' : 'minúsculas, dígitos e hífen, com "plugin:" na frente quando a skill é de um plugin'
        problemas.push(`${nome}: id "${id}" usa ${forma}`)
      }
      if (vistos.has(id)) problemas.push(`${nome}: id "${id}" repetido`)
      vistos.add(id)
    }
  }

  // casa.json: a da pessoa soma as listas (ou troca a lista livre, com substituirListaLivre)
  const casa: Casa = { listaLivre: [], naoToque: [], comandosRecusados: [] }
  for (const fonte of FONTES) {
    const caminho = `${fonte.prefixo}casa.json`
    const casaBruta = lerJson(arquivos, caminho, problemas, !fonte.pessoa)
    if (casaBruta === undefined) continue
    if (!objeto(casaBruta)) {
      problemas.push(`${caminho}: não é um objeto`)
      continue
    }
    const presente = (campo: string): boolean => !fonte.pessoa || casaBruta[campo] !== undefined
    if (fonte.pessoa && casaBruta.substituirListaLivre !== undefined && typeof casaBruta.substituirListaLivre !== 'boolean') {
      problemas.push(`${caminho}: substituirListaLivre é true ou false`)
    }
    if (textos(casaBruta.listaLivre)) {
      casa.listaLivre = fonte.pessoa && casaBruta.substituirListaLivre === true ? [...new Set(casaBruta.listaLivre)] : [...new Set([...casa.listaLivre, ...casaBruta.listaLivre])]
    } else if (presente('listaLivre')) problemas.push(`${caminho}: listaLivre é uma lista de nomes`)
    if (textos(casaBruta.naoToque)) casa.naoToque = [...new Set([...casa.naoToque, ...casaBruta.naoToque])]
    else if (presente('naoToque')) problemas.push(`${caminho}: naoToque é uma lista de caminhos`)
    if (Array.isArray(casaBruta.comandosRecusados)) {
      casaBruta.comandosRecusados.forEach((c, i) => {
        if (!objeto(c) || !texto(c.padrao) || !texto(c.motivo)) return void problemas.push(`${caminho}: comandosRecusados[${i}] tem "padrao" e "motivo"`)
        let regra: RegExp
        try {
          regra = new RegExp(c.padrao, 'i')
        } catch {
          return void problemas.push(`${caminho}: comandosRecusados[${i}] não é uma expressão regular válida`)
        }
        // os exemplos que a regra recusa e os que ela deixa passar, conferidos aqui pelo mesmo caminho do porteiro
        // (comandoRecusado, que procura no código do comando): uma regra mexida que deixa de pegar o caso dela (ou
        // passa a pegar o dia a dia) aparece como problema da prateleira
        const so = [{ padrao: regra.source, motivo: c.motivo }]
        for (const exemplo of textos(c.recusa) ? c.recusa : []) {
          if (comandoRecusado(exemplo, so) === undefined) problemas.push(`${caminho}: comandosRecusados[${i}] não recusa o exemplo "${exemplo}"`)
        }
        for (const exemplo of textos(c.passa) ? c.passa : []) {
          if (comandoRecusado(exemplo, so) !== undefined) problemas.push(`${caminho}: comandosRecusados[${i}] recusa o exemplo "${exemplo}", que deve passar`)
        }
        if (!casa.comandosRecusados.some(x => x.padrao === c.padrao)) casa.comandosRecusados.push({ padrao: c.padrao, motivo: c.motivo })
      })
    } else if (presente('comandosRecusados')) problemas.push(`${caminho}: comandosRecusados é uma lista`)
  }

  // aprovados.json
  let aprovados: Aprovado[] = []
  for (const fonte of FONTES) {
    const caminho = `${fonte.prefixo}aprovados.json`
    const daFonte: Aprovado[] = []
    const aprovadosBrutos = lerJson(arquivos, caminho, problemas, !fonte.pessoa)
    const listaAprovados = objeto(aprovadosBrutos) ? aprovadosBrutos.aprovados : undefined
    if (Array.isArray(listaAprovados)) {
      listaAprovados.forEach((a, i) => {
        const onde = `${caminho}: aprovados[${i}]`
        if (!objeto(a)) return void problemas.push(`${onde}: não é um objeto`)
        if (faltam(onde, a, ['id', 'nome', 'origem', 'versao', 'quandoUsar', 'lote'], problemas)) return
        if (a.tipo !== 'skill') return void problemas.push(`${onde}: tipo é "skill"`)
        if (typeof a.peso !== 'number') return void problemas.push(`${onde}: peso é o número de caracteres do SKILL.md`)
        daFonte.push(a as unknown as Aprovado)
      })
    } else if (aprovadosBrutos !== undefined) problemas.push(`${caminho}: falta a lista "aprovados"`)
    unicos(`aprovados${fonte.rotulo}`, daFonte.map(a => a.id), ID_SKILL)
    aprovados = juntarPorId(aprovados, daFonte)
  }

  // kits.json
  let kits: Kit[] = []
  for (const fonte of FONTES) {
    const caminho = `${fonte.prefixo}kits.json`
    const daFonte: Kit[] = []
    const kitsBrutos = lerJson(arquivos, caminho, problemas, !fonte.pessoa)
    const listaKits = objeto(kitsBrutos) ? kitsBrutos.kits : undefined
    if (Array.isArray(listaKits)) {
      listaKits.forEach((k, i) => {
        const onde = `${caminho}: kits[${i}]`
        if (!objeto(k)) return void problemas.push(`${onde}: não é um objeto`)
        if (faltam(onde, k, ['id', 'nome', 'quandoUsar'], problemas)) return
        if (!textos(k.ferramentas)) return void problemas.push(`${onde}: ferramentas é uma lista de nomes`)
        if (typeof k.escreve !== 'boolean' || typeof k.shell !== 'boolean') return void problemas.push(`${onde}: escreve e shell são verdadeiro ou falso`)
        for (const s of textos(k.skills) ? k.skills : []) {
          if (!aprovados.some(a => a.id === s)) problemas.push(`${onde} (${String(k.id)}): cita a skill "${s}", que não está em aprovados.json`)
        }
        if (k.notas !== undefined) conferirRegras(`${onde}.notas`, k.notas, problemas)
        if (k.codex !== undefined) {
          if (!objeto(k.codex)) return void problemas.push(`${onde} (${String(k.id)}): codex é um objeto com config, habilitar e desabilitar`)
          for (const campo of ['config', 'habilitar', 'desabilitar'] as const) {
            const valor = k.codex[campo]
            if (valor !== undefined && !(textos(valor) && valor.every(x => x.trim() !== ''))) {
              return void problemas.push(`${onde} (${String(k.id)}): codex.${campo} é uma lista de textos`)
            }
          }
          for (const par of textos(k.codex.config) ? k.codex.config : []) {
            if (!/^[^=\s][^=]*=/.test(par)) problemas.push(`${onde} (${String(k.id)}): codex.config "${par}" não tem a forma chave=valor`)
          }
        }
        daFonte.push(k as unknown as Kit)
      })
    } else if (kitsBrutos !== undefined) problemas.push(`${caminho}: falta a lista "kits"`)
    unicos(`kits${fonte.rotulo}`, daFonte.map(k => k.id))
    kits = juntarPorId(kits, daFonte)
  }

  // motores.json: só o do plugin
  const motores: Motor[] = []
  const motoresBrutos = lerJson(arquivos, 'prateleira/motores.json', problemas)
  const listaMotores = objeto(motoresBrutos) ? motoresBrutos.motores : undefined
  let padroes = 0
  const idsModelo = new Set<string>()
  if (Array.isArray(listaMotores)) {
    listaMotores.forEach((m, i) => {
      const onde = `prateleira/motores.json: motores[${i}]`
      if (!objeto(m) || (m.id !== 'claude' && m.id !== 'codex') || !texto(m.nome) || !Array.isArray(m.modelos)) {
        return void problemas.push(`${onde}: tem id (claude ou codex), nome e modelos`)
      }
      const modelos = m.modelos.filter((d, j) => {
        const ondeModelo = `${onde}.modelos[${j}]`
        if (!objeto(d)) return problemas.push(`${ondeModelo}: não é um objeto`) && false
        if (faltam(ondeModelo, d, ['id', 'nome', 'quandoUsar'], problemas)) return false
        if (!textos(d.esforcos) || d.esforcos.length === 0 || d.esforcos.some(e => !ESFORCOS.includes(e))) {
          return problemas.push(`${ondeModelo}: esforcos é uma lista tirada de ${ESFORCOS.join(', ')}`) && false
        }
        if (idsModelo.has(String(d.id))) return problemas.push(`${ondeModelo}: id de modelo "${String(d.id)}" repetido`) && false
        idsModelo.add(String(d.id))
        if (d.padrao === true) padroes += 1
        return true
      })
      motores.push({ id: m.id, nome: m.nome, modelos } as unknown as Motor)
    })
  } else if (motoresBrutos !== undefined) problemas.push('prateleira/motores.json: falta a lista "motores"')
  if (padroes > 1) problemas.push(`prateleira/motores.json: ${padroes} modelos marcados como padrão; só um pode ser`)
  if (padroes === 0 && motoresBrutos !== undefined) problemas.push('prateleira/motores.json: nenhum modelo marcado como padrão; a ficha sem "modelo" precisa de um')

  // projetos/<id>.json
  let projetos: Projeto[] = []
  for (const fonte of FONTES) {
    const daFonte: Projeto[] = []
    const molde = new RegExp(`^${fonte.prefixo.replace(/[/]/g, '\\/')}projetos\\/[^/]+\\.json$`)
    for (const caminho of Object.keys(arquivos).filter(c => molde.test(c)).sort()) {
      const bruto = lerJson(arquivos, caminho, problemas)
      if (!objeto(bruto)) continue
      const esperado = caminho.slice(`${fonte.prefixo}projetos/`.length, -'.json'.length)
      if (faltam(caminho, bruto, ['id', 'nome', 'resumo', 'conferidoEm'], problemas)) continue
      if (bruto.id !== esperado) {
        problemas.push(`${caminho}: id "${String(bruto.id)}" difere do nome do arquivo`)
        continue
      }
      if (bruto.id === ESTA_PASTA) {
        problemas.push(`${caminho}: o id "${ESTA_PASTA}" é o da pasta da sessão, que o mod já oferece; use outro id`)
        continue
      }
      if (!textos(bruto.naoToque)) {
        problemas.push(`${caminho}: naoToque é uma lista (pode ser vazia)`)
        continue
      }
      if (!conferirRegras(`${caminho}: regras`, bruto.regras, problemas)) continue
      if (bruto.pc !== undefined && (!objeto(bruto.pc) || !texto(bruto.pc.pasta))) problemas.push(`${caminho}: pc.pasta é obrigatório quando há pc`)
      // "vps" fica no formato, mas esta edição só trabalha neste computador: o campo é lido e ignorado
      if (bruto.vps !== undefined && !objeto(bruto.vps)) problemas.push(`${caminho}: vps é um objeto`)
      for (const k of textos(bruto.kitsSugeridos) ? bruto.kitsSugeridos : []) {
        if (!kits.some(x => x.id === k)) problemas.push(`${caminho}: sugere o kit "${k}", que não está em kits.json`)
      }
      daFonte.push(bruto as unknown as Projeto)
    }
    unicos(`projetos${fonte.rotulo}`, daFonte.map(p => p.id))
    projetos = juntarPorId(projetos, daFonte)
  }

  // tipos/<id>.json
  let tipos: TipoTrabalho[] = []
  for (const fonte of FONTES) {
    const daFonte: TipoTrabalho[] = []
    const molde = new RegExp(`^${fonte.prefixo.replace(/[/]/g, '\\/')}tipos\\/[^/]+\\.json$`)
    for (const caminho of Object.keys(arquivos).filter(c => molde.test(c)).sort()) {
      const bruto = lerJson(arquivos, caminho, problemas)
      if (!objeto(bruto)) continue
      const esperado = caminho.slice(`${fonte.prefixo}tipos/`.length, -'.json'.length)
      if (faltam(caminho, bruto, ['id', 'nome', 'prontoExemplo'], problemas)) continue
      if (bruto.id !== esperado) {
        problemas.push(`${caminho}: id "${String(bruto.id)}" difere do nome do arquivo`)
        continue
      }
      if (!conferirRegras(`${caminho}: metodo`, bruto.metodo, problemas)) continue
      if (typeof bruto.esforcoPadrao !== 'string' || !ESFORCOS.includes(bruto.esforcoPadrao)) {
        problemas.push(`${caminho}: esforcoPadrao fora da lista ${ESFORCOS.join(', ')}`)
        continue
      }
      if (!textos(bruto.kitPadrao)) {
        problemas.push(`${caminho}: kitPadrao é uma lista de ids de kit`)
        continue
      }
      for (const k of bruto.kitPadrao) if (!kits.some(x => x.id === k)) problemas.push(`${caminho}: cita o kit "${k}", que não está em kits.json`)
      daFonte.push(bruto as unknown as TipoTrabalho)
    }
    unicos(`tipos${fonte.rotulo}`, daFonte.map(t => t.id))
    tipos = juntarPorId(tipos, daFonte)
  }

  // licoes.json
  let licoes: Licao[] = []
  for (const fonte of FONTES) {
    const caminho = `${fonte.prefixo}licoes.json`
    const daFonte: Licao[] = []
    const licoesBrutas = lerJson(arquivos, caminho, problemas, !fonte.pessoa)
    const listaLicoes = objeto(licoesBrutas) ? licoesBrutas.licoes : undefined
    if (Array.isArray(listaLicoes)) {
      listaLicoes.forEach((l, i) => {
        const onde = `${caminho}: licoes[${i}]`
        if (!objeto(l)) return void problemas.push(`${onde}: não é um objeto`)
        if (faltam(onde, l, ['id', 'regra', 'motivo'], problemas)) return
        if (!textos(l.vale) || l.vale.length === 0) return void problemas.push(`${onde}: vale é uma lista ("todos", ou ids de tipo, projeto ou kit)`)
        for (const alvo of l.vale) {
          const existe = alvo === 'todos' || alvo === ESTA_PASTA || tipos.some(t => t.id === alvo) || projetos.some(p => p.id === alvo) || kits.some(k => k.id === alvo)
          if (!existe) problemas.push(`${onde} (${String(l.id)}): vale cita "${alvo}", que não é "todos" nem id de tipo, projeto ou kit`)
        }
        if (l.soComGit !== undefined && typeof l.soComGit !== 'boolean') problemas.push(`${onde} (${String(l.id)}): soComGit é true ou false`)
        daFonte.push(l as unknown as Licao)
      })
    } else if (licoesBrutas !== undefined) problemas.push(`${caminho}: falta a lista "licoes"`)
    unicos(`licoes${fonte.rotulo}`, daFonte.map(l => l.id))
    licoes = juntarPorId(licoes, daFonte)
  }

  // devolucao.md: só a do plugin
  const devolucao = arquivos['prateleira/devolucao.md'] ?? ''
  if (devolucao.trim() === '') problemas.push('prateleira/devolucao.md: ausente ou vazio')

  return { prateleira: { casa, motores, projetos, tipos, kits, aprovados, licoes, devolucao }, problemas }
}

/** O projeto da pasta da sessão: existe sem arquivo, para o primeiro especialista nascer sem preparo. */
export function projetoDaPasta(pasta: string, hoje: string): Projeto {
  const limpa = pasta.replace(/\\/g, '/').replace(/\/+$/, '')
  const nome = limpa.split('/').filter(Boolean).at(-1) ?? limpa
  return {
    id: ESTA_PASTA,
    nome: `${nome} (pasta desta sessão)`,
    resumo: 'A pasta em que esta sessão do Claude Code foi aberta, sem ficha de projeto gravada: como testar, o que não tocar e as regras vêm no dossiê.',
    conferidoEm: hoje,
    pc: { pasta: limpa },
    naoToque: [],
    regras: [],
  }
}

/** O que `carregar` devolve: a prateleira, os problemas (que fazem montar recusar) e os avisos (que só informam). */
export type Carga = { prateleira: Prateleira; problemas: string[]; avisos: string[]; pastaPessoa: string }

/** Lê os .json e .md de uma pasta de prateleira (um nível, mais projetos/ e tipos/), cada um com o prefixo dado. */
async function lerPrateleira($: EngineInterface, raiz: string, prefixo: string, arquivos: Record<string, string>): Promise<void> {
  const lerPasta = async (sub: string): Promise<void> => {
    const pasta = sub === '' ? raiz : `${raiz}/${sub}`
    let entradas: { name: string; kind: string }[] = []
    try {
      entradas = await $.fs.list(pasta)
    } catch {
      return
    }
    for (const entrada of entradas) {
      if (entrada.kind !== 'file' || !/\.(json|md)$/.test(entrada.name)) continue
      const rel = `${prefixo}${sub === '' ? '' : `${sub}/`}${entrada.name}`
      try {
        arquivos[rel] = String(await $.fs.read(`${pasta}/${entrada.name}`))
      } catch {
        /* o problema "arquivo ausente" diz o resto */
      }
    }
  }
  await lerPasta('')
  await lerPasta('projetos')
  await lerPasta('tipos')
}

/** A impressão digital SHA-256 de um texto, como "sha256:<hex>" (os bytes UTF-8 do texto, que são os do arquivo). */
export async function impressaoDigital(textoDoArquivo: string): Promise<string> {
  const bytes = new TextEncoder().encode(textoDoArquivo)
  const resumo = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `sha256:${[...resumo].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Confere cada skill aprovada que tem caminho de arquivo e impressão digital: a que mudou desde a aprovação, ou cujo
 * arquivo sumiu, sai da prateleira (o chefe não a vê e a ficha não a leva) e vira aviso. Devolve os avisos.
 */
export async function conferirSkillsAprovadas($: EngineInterface, prateleira: Prateleira, casa: string): Promise<string[]> {
  const avisos: string[] = []
  const fora = new Set<string>()
  for (const a of prateleira.aprovados) {
    if (!a.versao.startsWith('sha256:')) continue
    const caminho = a.origem.startsWith('~/') ? `${casa}/${a.origem.slice(2)}` : a.origem
    if (!/^(?:[A-Za-z]:)?[\\/]/.test(caminho)) continue
    let conteudo: string
    try {
      conteudo = String(await $.fs.read(caminho))
    } catch {
      fora.add(a.id)
      avisos.push(`A skill ${a.id} saiu dos especialistas: o arquivo ${a.origem} não existe mais. Aprove de novo com a ferramenta skills, se ela mudou de lugar.`)
      continue
    }
    if ((await impressaoDigital(conteudo)) !== a.versao.toLowerCase()) {
      fora.add(a.id)
      avisos.push(`A skill ${a.id} saiu dos especialistas: o SKILL.md mudou desde a aprovação. Ela volta quando a pessoa aprovar de novo (ferramenta skills).`)
    }
  }
  if (fora.size) prateleira.aprovados = prateleira.aprovados.filter(a => !fora.has(a.id))
  return avisos
}

/** O texto de cada arquivo das duas prateleiras, pelas chaves de `montarPrateleira`, e a pasta da da pessoa. */
export async function arquivosDaPrateleira($: EngineInterface): Promise<{ arquivos: Record<string, string>; pastaPessoa: string }> {
  const raiz = `${$.plugin.root.replace(/\\/g, '/').replace(/\/$/, '')}/prateleira`
  const pastaPessoa = prateleiraDaPessoa(await configDe($))
  const arquivos: Record<string, string> = {}
  await lerPrateleira($, raiz, 'prateleira/', arquivos)
  await lerPrateleira($, pastaPessoa, PREFIXO_PESSOA, arquivos)
  return { arquivos, pastaPessoa }
}

/**
 * Lê a prateleira do plugin e a da pessoa e monta as duas juntas. Depois confere as skills aprovadas (impressão
 * digital) e junta a pasta da sessão como o projeto "esta-pasta". Os problemas da prateleira da pessoa citam o
 * caminho real dela.
 */
export async function carregar($: EngineInterface): Promise<Carga> {
  const { arquivos, pastaPessoa } = await arquivosDaPrateleira($)
  const { prateleira, problemas } = montarPrateleira(arquivos)
  const avisos = await conferirSkillsAprovadas($, prateleira, await casaDe($))
  const cwd = await $.session.cwd().catch(() => undefined)
  if (cwd !== undefined && cwd.trim() !== '') prateleira.projetos.push(projetoDaPasta(cwd, hojeIso(await $.clock.now())))
  const mostrar = (p: string): string => (p.startsWith(PREFIXO_PESSOA) ? `${pastaPessoa}/${p.slice(PREFIXO_PESSOA.length)}` : p)
  return { prateleira, problemas: problemas.map(mostrar), avisos, pastaPessoa }
}

/** A prateleira guardada por 30 s, para os porteiros não lerem os arquivos a cada chamada. */
let guardada: { em: number; cwd: string; valor: Carga } | undefined
const GUARDA_MS = 30_000

export async function prateleiraAgora($: EngineInterface, fresca = false): Promise<Carga> {
  const agora = await $.clock.now()
  const cwd = await $.session.cwd().catch(() => '')
  if (!fresca && guardada !== undefined && guardada.cwd === cwd && agora >= guardada.em && agora - guardada.em < GUARDA_MS) return guardada.valor
  const valor = await carregar($)
  guardada = { em: agora, cwd, valor }
  return valor
}

/** Esquece a prateleira guardada: depois de gravar um projeto ou aprovar uma skill, a próxima leitura é fresca. */
export function esquecerPrateleira(): void {
  guardada = undefined
}

/**
 * Os ajudantes que vêm no Claude Code. Só entram na lista livre pelo nome exato, nunca por um prefixo com "*". Os
 * nomes conhecidos nesta versão vêm aqui; os outros entram quando o motor os oferece com a origem `built-in`.
 */
const TIPOS_DO_MOTOR = new Set(['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'web-fetch', 'claude'])

/** O motor ofereceu este tipo com a origem `built-in` (agent.offer): passa a contar como ajudante do Claude Code. */
export function anotarTipoDoMotor(tipo: string): void {
  TIPOS_DO_MOTOR.add(tipo)
}

export const ehTipoDoMotor = (tipo: string): boolean => TIPOS_DO_MOTOR.has(tipo)

/**
 * Um tipo está na lista livre? "*" no fim vale como prefixo ("meu-plugin:*"). Um ajudante que vem no Claude Code só
 * está quando a lista o cita pelo nome exato.
 */
export function naListaLivre(tipo: string, listaLivre: readonly string[]): boolean {
  if (TIPOS_DO_MOTOR.has(tipo)) return listaLivre.includes(tipo)
  return listaLivre.some(item => (item.endsWith('*') ? tipo.startsWith(item.slice(0, -1)) : tipo === item))
}

// ------------------------------------------------------------------------------------------ cardápio

export type DadosCardapio = {
  prateleira: Prateleira
  problemas: readonly string[]
  pedido: { projeto?: string; tipo?: string }
  modo: string
  liberacao: 'nenhuma' | 'sessao'
  vagas: number
  teto: number
  memoriaGb: number | null
  pisoGb: number
  orcamento: number
  /** Modelos do Codex que podem ser usados agora. Vazio: o cardápio não fala do Codex. */
  codexDisponiveis: readonly string[]
  /** Como o especialista do Codex nasce nesta sessão: nativo (o astra ligado) ou por roteiro, e por quê. */
  codexJeito?: { nativo: true } | { nativo: false; motivo: 'opcao' | 'sem-astra' }
  /** Avisos da carga (skill aprovada que mudou ou sumiu): não impedem montar. */
  avisos?: readonly string[]
  /** A prateleira da pessoa, para o cardápio dizer onde ela fica. */
  pastaPessoa?: string
}

export const gb = (n: number): string => n.toFixed(1).replace('.', ',')

/** A régua em uma linha por item, como `montar` confere. */
export const REGUA: readonly string[] = [
  '1. dossie.objetivo diz o quê e o porquê (40 caracteres ou mais).',
  '2. Cada caminho de dossie.trabalheSoEm existe, ou está também em dossie.criar.',
  '3. dossie.pronto tem "esperado" e mais "comando" ou "comoVer".',
  '4. O território não cruza o de outro especialista (do time ou do mesmo pedido).',
  '5. dossie.limitesDeAcao não é vazio.',
  '6. Projeto, tipo, kits, skills e modelo existem na prateleira; o esforço é um dos do modelo (no Codex nativo, pelo astra, até max: o ultra só no roteiro).',
  '7. O texto da ficha cabe no orçamento.',
  '8. nome: minúsculas, dígitos e hífen, até 40, ainda não usado nesta sessão.',
  '9. motivoModelo quando o modelo do Claude não é o padrão ou o esforço passa de high.',
  '10. Com porte "grande", ficha cujo kit escreve traz desenho.caminho (que existe) e desenho.fase.',
  '11. No Claude, só sonnet ou opus; fable só com pedidoDono, as palavras do dono nesta conversa que pedem o Fable.',
  '"decida", "o que achar melhor" e "a definir" só geram aviso.',
]

/**
 * Um projeto no cardápio: o que o chefe precisa para escrever a ficha (pasta, como testar, o que não se
 * escreve, kits sugeridos) e as regras só pelo enunciado. Os motivos vão na ficha do especialista, não aqui.
 */
export function resumoProjeto(p: Projeto): string[] {
  const linhas = [`Projeto ${p.id} (${p.nome}), conferido em ${p.conferidoEm}. ${p.resumo.trim()}`]
  if (p.pc !== undefined) {
    const extras = [p.pc.repositorio ? `repositório ${p.pc.repositorio}` : '', p.pc.ramoPrincipal ? `ramo principal ${p.pc.ramoPrincipal}` : ''].filter(Boolean)
    linhas.push(`- Pasta: ${p.pc.pasta}${extras.length ? `; ${extras.join('; ')}` : ''}`)
    if (p.pc.comoRodar?.length) linhas.push(`- Como rodar: ${p.pc.comoRodar.join('; ')}`)
    if (p.pc.comoTestar?.length) linhas.push(`- Como testar: ${p.pc.comoTestar.join('; ')}`)
  } else linhas.push('- Não tem pasta neste computador, e esta edição só trabalha em pastas deste computador: grave a pasta com gravar_projeto.')
  if (p.id === ESTA_PASTA) linhas.push('- Sem ficha gravada: diga no dossiê como testar e o que não tocar. Para o projeto valer nas próximas sessões, grave a ficha com gravar_projeto.')
  if (p.stack?.length) linhas.push(`- Pilha: ${p.stack.join(', ')}`)
  if (p.naoToque.length) linhas.push(`- Ninguém escreve em (o mod recusa): ${p.naoToque.join(', ')}`)
  if (p.kitsSugeridos?.length) linhas.push(`- Kits sugeridos: ${p.kitsSugeridos.join(', ')}`)
  if (p.regras.length) linhas.push('- Regras que a ficha já leva, com os motivos (não repita no dossiê):', ...p.regras.map(r => `  - ${r.regra.trim()}`))
  return linhas
}

/** Como o especialista do Codex nasce nesta sessão, em uma linha do cardápio: como chamá-lo e o que instalar. */
export function linhaDoCodex(jeito: NonNullable<DadosCardapio['codexJeito']>): string {
  if (jeito.nativo) {
    return 'Codex nesta sessão: nativo, pelo plugin astra. O especialista do Codex vira o tipo alrix-equipe:<nome>, como os do Claude: chame com Agent no turno seguinte ao montar, e o mod põe no primeiro pedido a linha "cwd:" com a pasta do projeto. Esforço de low a max (o ultra só existe no roteiro).'
  }
  if (jeito.motivo === 'opcao') {
    return 'Codex nesta sessão: por roteiro, porque a opção codexNativo está em "roteiro". O especialista do Codex se chama com acionar, e o mod avisa quando ele termina.'
  }
  return 'Codex nesta sessão: por roteiro, porque o plugin astra não está ligado. O especialista do Codex se chama com acionar, e o mod avisa quando ele termina. Para chamá-lo com Agent, como os do Claude, a pessoa instala e liga o plugin astra e abre a sessão de novo.'
}

/** O texto que `cardapio` devolve ao chefe. */
export function textoCardapio(d: DadosCardapio): string {
  const p = d.prateleira
  const linhas: string[] = []
  const memoria = d.memoriaGb === null ? 'memória livre não lida' : `${gb(d.memoriaGb)} GB livres (piso ${gb(d.pisoGb)} GB)`
  const liberacao =
    d.liberacao === 'sessao'
      ? 'liberada nesta sessão (o cartão só volta para Fable, Codex e esforço acima de high)'
      : 'o próximo time pede o cartão do dono, e "Liberar nesta sessão" dispensa os seguintes de Sonnet e Opus'
  linhas.push(`Equipe: ${d.vagas} de ${d.teto} vagas · ${memoria} · modo ${d.modo} · ${liberacao}.`)
  if (d.problemas.length) linhas.push('', 'A prateleira tem problemas, e montar recusa até corrigir:', ...d.problemas.map(x => `- ${x}`))
  if (d.avisos?.length) linhas.push('', 'Avisos da prateleira (não impedem montar):', ...d.avisos.map(x => `- ${x}`))

  linhas.push('', 'Modelos (campo "modelo" da ficha):')
  const codexNativo = d.codexJeito?.nativo === true
  for (const motor of p.motores) {
    for (const m of motor.modelos) {
      if (motor.id === 'codex' && !d.codexDisponiveis.includes(m.id)) continue
      // no Codex nativo, o esforço é o de um tipo de agente do Claude Code: o ultra fica de fora
      const esforcos = motor.id === 'codex' && codexNativo ? m.esforcos.filter(x => ESFORCOS_DO_AGENTE.includes(x)) : m.esforcos
      // A política de modelos e a regra do cartão são do código (ficha.ts), não do campo `cartao` da prateleira.
      const uso = motor.id === 'claude' ? usoDoModelo(m.id) : 'livre'
      if (uso === 'fora') continue
      const cartao =
        motor.id === 'codex'
          ? 'cartão sempre'
          : uso === 'pedidoDono'
            ? 'cartão sempre, pede motivoModelo e só entra com o pedido do dono nesta conversa, copiado em pedidoDono'
            : m.padrao
              ? 'cartão do time'
              : 'cartão do time, pede motivoModelo'
      linhas.push(`- ${m.id}${m.padrao ? ' (padrão)' : ''}: ${m.nome}. ${m.quandoUsar.trim()} Esforços: ${esforcos.join(', ')}. ${cartao}.`)
    }
  }
  if (d.codexDisponiveis.length && d.codexJeito !== undefined) linhas.push(linhaDoCodex(d.codexJeito))
  linhas.push(`Esforço acima de high (${ESFORCOS_COM_CARTAO.join(', ')}) pede cartão sempre e motivoModelo, em qualquer modelo.`)
  linhas.push('Esforço medium (médio) serve ao trabalho mecânico, em que não há o que decidir (renomear, aplicar uma mudança já decidida, rodar um roteiro e relatar); o que pede julgamento fica em high.')

  const projeto = d.pedido.projeto === undefined ? undefined : p.projetos.find(x => x.id === d.pedido.projeto)
  if (projeto !== undefined) linhas.push('', ...resumoProjeto(projeto))
  else {
    if (d.pedido.projeto !== undefined) linhas.push('', `O projeto "${d.pedido.projeto}" não está na prateleira.`)
    linhas.push('', 'Projetos (peça cardapio com projeto para ver um inteiro):', ...p.projetos.map(x => `- ${x.id}: ${x.nome}. ${x.resumo.trim()}`))
    const daPasta = p.projetos.find(x => x.id === ESTA_PASTA)
    if (daPasta?.pc !== undefined) {
      const gravado = p.projetos.find(x => x.id !== ESTA_PASTA && x.pc !== undefined && x.pc.pasta.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === daPasta.pc?.pasta.toLowerCase())
      linhas.push(
        gravado !== undefined
          ? `A pasta desta sessão já tem a ficha do projeto ${gravado.id}: prefira-o a ${ESTA_PASTA}, porque ele já traz como testar e as regras.`
          : `Primeiro uso: com projeto "${ESTA_PASTA}" o especialista trabalha na pasta desta sessão (${daPasta.pc.pasta}) sem arquivo nenhum. Para o projeto ficar guardado, com pasta, como testar, o que não tocar e regras com motivo, grave a ficha com gravar_projeto${d.pastaPessoa ? ` (vai para ${d.pastaPessoa}/projetos)` : ''}.`,
      )
    }
  }

  const tipo = d.pedido.tipo === undefined ? undefined : p.tipos.find(x => x.id === d.pedido.tipo)
  if (tipo !== undefined) {
    linhas.push('', `Tipo ${tipo.id} (${tipo.nome}): kit padrão ${tipo.kitPadrao.join(', ')}; esforço padrão ${tipo.esforcoPadrao}.`)
    if (tipo.metodo.length) linhas.push('Método que a ficha já leva, com os motivos (não repita no dossiê):', ...tipo.metodo.map(m => `- ${m.regra.trim()}`))
    linhas.push(`Exemplo de pronto: ${tipo.prontoExemplo}`)
  } else {
    if (d.pedido.tipo !== undefined) linhas.push('', `O tipo "${d.pedido.tipo}" não está na prateleira.`)
    linhas.push('', 'Tipos de trabalho:', ...p.tipos.map(x => `- ${x.id}: ${x.nome} (kit padrão ${x.kitPadrao.join(', ')}; esforço ${x.esforcoPadrao})`))
  }

  linhas.push('', 'Kits:')
  for (const k of p.kits) {
    const marcas = [k.escreve ? 'escreve' : 'só lê', k.shell ? 'com shell' : 'sem shell'].join(', ')
    linhas.push(`- ${k.id}: ${k.nome}. ${k.quandoUsar.trim()} (${marcas}; ${k.ferramentas.join(', ')})`)
  }
  // Com projeto ou tipo pedido, o chefe já está escrevendo a ficha: as skills vão só pelo nome, e a
  // descrição de cada uma fica no cardápio sem argumentos.
  const focado = projeto !== undefined || tipo !== undefined
  if (p.aprovados.length && focado) {
    const dosKits = new Set(p.kits.flatMap(k => k.skills ?? []))
    linhas.push(
      '',
      `Skills aprovadas (campo "skills"; "*" já vem com um kit; para ver quando usar cada uma, peça cardapio sem projeto e sem tipo): ${p.aprovados.map(a => `${a.id}${dosKits.has(a.id) ? '*' : ''}`).join(', ')}.`,
    )
  } else if (p.aprovados.length) {
    linhas.push('', 'Skills aprovadas (campo "skills"):', ...p.aprovados.map(a => `- ${a.id}: ${a.nome}. ${a.quandoUsar.trim()} (${a.peso} caracteres)`))
  }
  linhas.push(
    '',
    `${p.aprovados.length ? 'Para aprovar mais' : 'Skills aprovadas: nenhuma ainda. Para dar a um especialista uma skill que a pessoa já tem instalada'}, use a ferramenta skills: sem argumentos ela lista as instaladas; com "aprovar" a pessoa confirma num cartão, e só então a skill entra aqui.`,
  )
  if (p.casa.listaLivre.length) linhas.push('', `Sem ficha (lista livre): ${p.casa.listaLivre.join(', ')}.`)

  // O que a ficha leva sozinha: o chefe não redigita no dossiê.
  const alvos = new Set(['todos', ...(tipo ? [tipo.id] : []), ...(projeto ? [projeto.id] : [])])
  const licoes = p.licoes.filter(l => l.vale.some(v => alvos.has(v)))
  linhas.push(
    '',
    'A ficha já leva sozinha, sem você escrever: as regras do projeto, o método do tipo, as notas de cada kit, o molde de devolução, a data de hoje, o ramo e as versões' +
      (licoes.length ? `, e ${licoes.length === 1 ? 'a lição' : `as ${licoes.length} lições`} da casa abaixo` : '') +
      '. No dossiê vai só o que é desta tarefa.',
  )
  // T-08: o texto de cada lição, uma linha cada, para o chefe não repeti-las nas restrições (o montar avisa quando repete).
  if (licoes.length) linhas.push('Lições da casa que a ficha leva (o montar avisa se uma restrição repete uma delas):',...licoes.map(l => `- ${l.id}: ${l.regra.trim()}`))

  linhas.push('', `A régua (orçamento ${d.orcamento} caracteres):`, ...REGUA)

  const molde = {
    time: [
      {
        nome: 'projeto-frente-curta',
        descricao: 'Quando chamar este especialista, em uma linha.',
        projeto: projeto?.id ?? '<id do projeto>',
        tipo: tipo?.id ?? '<id do tipo>',
        kits: tipo?.kitPadrao ?? ['<id do kit>'],
        modelo: p.motores.flatMap(m => m.modelos).find(m => m.padrao)?.id ?? '<id do modelo>',
        esforco: tipo?.esforcoPadrao ?? 'high',
        dossie: {
          objetivo: 'O que fazer, e para que (o porquê).',
          contexto: 'O que o especialista precisa saber e não está na prateleira.',
          estadoAlvo: 'Como as coisas ficam no fim.',
          trabalheSoEm: ['caminho/relativo/ao/projeto'],
          criar: [],
          naoToqueEm: [],
          restricoes: [],
          pronto: { comando: 'o comando que prova', esperado: 'o que ele mostra quando está pronto' },
          limitesDeAcao: ['O que não pode fazer.'],
          relatorio: 'O que a resposta traz.',
        },
      },
    ],
  }
  linhas.push('', 'Molde (montar):', JSON.stringify(molde))
  linhas.push(
    '',
    'As outras ferramentas do mod ficam guardadas. Carregue a que for usar com ToolSearch, por exemplo "select:mcp__alrix-equipe__montar": ' +
      'montar (cria o time), time (lista o time), ampliar (território), dispensar, acionar (põe um especialista do Codex por roteiro para trabalhar), propor_licao, gravar_projeto (guarda a ficha de um projeto na prateleira da pessoa) e skills (lista e aprova skills instaladas).',
  )
  return linhas.join('\n')
}
