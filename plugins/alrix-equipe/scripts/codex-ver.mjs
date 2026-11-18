// Mostra, sem gastar cota, o que o modelo do Codex enxergaria numa execução: as skills, os grupos de
// ferramentas e as ferramentas, com e sem os ajustes de um pedido. Usa `codex debug prompt-input`, que
// monta a entrada do modelo e a imprime, sem chamar o modelo.
//
// Uso:
//   node scripts/codex-ver.mjs <pasta da missão>          lê pedido.json (config, habilitar, desabilitar, pasta, codexHome)
//   node scripts/codex-ver.mjs --config 'k=v' --enable x --disable y [--pasta dir] [--codex-home dir]
//
// Saída: uma linha JSON { ok, versao, base, equipado, saiu, entrou } com nomes, nunca o texto das instruções.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { executavel } from './codex-limite.mjs'

const argumentos = process.argv.slice(2)
const pedido = { config: [], habilitar: [], desabilitar: [], pasta: tmpdir(), codexHome: '' }
const juntar = (campo, valor) => {
  if (typeof valor !== 'string' || valor === '') throw new Error(`falta o valor de ${campo}`)
  pedido[campo].push(valor)
}

try {
  if (argumentos.length === 1 && !argumentos[0].startsWith('--')) {
    const lido = JSON.parse(readFileSync(join(resolve(argumentos[0]), 'pedido.json'), 'utf8').replace(/^﻿/, ''))
    for (const campo of ['config', 'habilitar', 'desabilitar']) {
      if (Array.isArray(lido[campo])) pedido[campo] = lido[campo].filter(x => typeof x === 'string' && x)
    }
    if (typeof lido.pasta === 'string' && lido.pasta) pedido.pasta = lido.pasta
    if (typeof lido.codexHome === 'string') pedido.codexHome = lido.codexHome
  } else {
    for (let i = 0; i < argumentos.length; i += 2) {
      const [nome, valor] = [argumentos[i], argumentos[i + 1]]
      if (nome === '--config') juntar('config', valor)
      else if (nome === '--enable') juntar('habilitar', valor)
      else if (nome === '--disable') juntar('desabilitar', valor)
      else if (nome === '--pasta') pedido.pasta = valor
      else if (nome === '--codex-home') pedido.codexHome = valor
      else throw new Error(`opção desconhecida: ${nome}`)
    }
  }
  if (!existsSync(pedido.pasta)) throw new Error(`a pasta ${pedido.pasta} não existe`)
} catch (erro) {
  console.log(JSON.stringify({ ok: false, erro: String(erro?.message ?? erro) }))
  process.exit(1)
}

const { comando, prefixo, shell } = executavel()
const ambiente = pedido.codexHome ? { ...process.env, CODEX_HOME: pedido.codexHome } : process.env
const rodar = extras =>
  execFileSync(comando, [...prefixo, ...extras], { cwd: pedido.pasta, env: ambiente, shell, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })

/** Só nomes: skills, grupos de ferramentas adiadas e ferramentas diretas. */
function ver(ajustes) {
  const itens = JSON.parse(rodar(['debug', 'prompt-input', ...ajustes, 'teste']))
  let skills = [], grupos = []
  const ferramentas = []
  for (const item of Array.isArray(itens) ? itens : []) {
    for (const f of Array.isArray(item.tools) ? item.tools : []) ferramentas.push(f.name ?? `(${f.type})`)
    for (const parte of Array.isArray(item.content) ? item.content : []) {
      const texto = typeof parte.text === 'string' ? parte.text : ''
      const linhas = texto.split('\n').map(l => l.trim())
      if (texto.startsWith('<skills_instructions>')) {
        skills = linhas.filter(l => /^-\s+[A-Za-z]/.test(l)).map(l => l.replace(/^-\s+/, '').replace(/: .*$/, ''))
      } else if (texto.startsWith('<tools>')) {
        grupos = linhas.filter(l => /^-\s+mcp__/.test(l)).map(l => l.replace(/^-\s+/, '').replace(/:.*$/, ''))
      }
    }
  }
  return { skills: skills.sort(), grupos: grupos.sort(), ferramentas: ferramentas.sort() }
}

const ajustes = [
  ...pedido.config.flatMap(par => ['-c', par]),
  ...pedido.habilitar.flatMap(nome => ['--enable', nome]),
  ...pedido.desabilitar.flatMap(nome => ['--disable', nome]),
]

try {
  const versao = rodar(['--version']).trim()
  const base = ver([])
  const equipado = ajustes.length ? ver(ajustes) : base
  const fora = (a, b) => a.filter(x => !b.includes(x))
  const diferenca = (de, para) => ({ skills: fora(de.skills, para.skills), grupos: fora(de.grupos, para.grupos), ferramentas: fora(de.ferramentas, para.ferramentas) })
  console.log(JSON.stringify({ ok: true, versao, ajustes, base, equipado, saiu: diferenca(base, equipado), entrou: diferenca(equipado, base) }))
} catch (erro) {
  console.log(JSON.stringify({ ok: false, erro: String(erro?.message ?? erro).slice(0, 400) }))
  process.exit(1)
}
