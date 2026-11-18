// Mede fichas montadas com a prateleira de verdade e o mesmo código que o mod usa (montarTexto, em
// hooks/ficha.ts): o peso de cada camada e o total, para comparar antes e depois de uma mudança na forma da
// ficha e para ver se a maior ficha cabe no orçamento.
//
// Uso: node scripts/medir-ficha.mjs [pasta do mod] [--texto] [--todas] [--colegas N] [--dossie N] [--so-padrao]
// Sem --todas, mede um exemplo (especialista de código no projeto alrix-equipe, com um colega); com --texto,
// imprime a ficha inteira. Com --todas, mede cada projeto com cada tipo (kits padrão do tipo mais todos os kits
// que não abrem ajudante, as skills de todos esses kits, o colega mais longo repetido N vezes, padrão 9, como
// num time de 10) e mostra as cinco maiores. Com --dossie N, o contexto do dossiê ganha texto até o dossiê
// passar de N caracteres, como uma ficha de tarefa grande. Com --so-padrao, cada tipo leva só os kits padrão dele. Pede Node 22.18 ou mais novo (lê .ts direto).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const opcao = nome => args.includes(nome)
const valor = (nome, padrao) => {
  const i = args.indexOf(nome)
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : padrao
}
const raiz = resolve(args.find((a, i) => !a.startsWith('--') && !['--colegas', '--dossie'].includes(args[i - 1] ?? '')) ?? join(dirname(fileURLToPath(import.meta.url)), '..'))

const arquivos = {}
for (const sub of ['', 'projetos', 'tipos']) {
  const dir = join(raiz, 'prateleira', sub)
  if (!existsSync(dir)) continue
  for (const n of readdirSync(dir).sort()) if (/\.(json|md)$/.test(n)) arquivos[`prateleira/${sub ? `${sub}/` : ''}${n}`] = readFileSync(join(dir, n), 'utf8')
}
const { montarPrateleira } = await import(pathToFileURL(join(raiz, 'hooks', 'prateleira.ts')).href)
const { montarTexto } = await import(pathToFileURL(join(raiz, 'hooks', 'ficha.ts')).href)
const { prateleira } = montarPrateleira(arquivos)

const fatos = { hoje: 'quinta, 12/11/2026', ramo: 'main', commit: 'abc1234', versoes: ['typescript 5.9.3'] }
const relatorioLongo = '~/.claude/alrix-equipe/sessoes/00000000-0000-0000-0000-000000000000/motor-exemplo.md'
const dossie = {
  objetivo: 'Trocar a regra X do mod para o dono conseguir Y, porque hoje Z atrapalha.',
  contexto: 'Leia o arquivo A antes.',
  trabalheSoEm: ['mod/hooks', 'mod/README.md'],
  pronto: { comando: 'claude plugin test mod', esperado: 'sem falha' },
  limitesDeAcao: ['Não instale o mod.'],
}
const alvoDossie = valor('--dossie', 0)
if (alvoDossie > 0) {
  const frase = 'O chefe explica aqui o caso com os arquivos, as decisões já tomadas e o que o dono pediu. '
  dossie.contexto = frase.repeat(Math.ceil(alvoDossie / frase.length)).slice(0, alvoDossie).trim()
}
const linha = pesos => Object.entries(pesos).map(([k, v]) => `${k} ${v}`).join(' · ')

if (!opcao('--todas')) {
  const ficha = { nome: 'motor-exemplo', descricao: 'Muda o código do mod alrix-equipe.', projeto: 'alrix-equipe', tipo: 'codigo', kits: ['codigo', 'pesquisa-web'], dossie }
  const colegas = [{ nome: 'equipe-prateleira', descricao: 'Cuida do conteúdo da prateleira.', escreve: ['mod/prateleira'] }]
  const { texto, pesos } = montarTexto(ficha, prateleira, fatos, { relatorioLongo, time: { colegas } })
  console.log(linha(pesos))
  if (opcao('--texto')) console.log(`\n${texto}`)
} else {
  const n = valor('--colegas', 9)
  // O colega mais longo que a ficha aceita: nome de 40 caracteres, descrição cortada em 160, dois caminhos.
  const colega = i => ({
    nome: `colega-${String(i).padStart(2, '0')}-${'x'.repeat(30)}`,
    descricao: 'Revisa a frio o diff inteiro do mod e confere cada afirmação do relatório contra o arquivo e a linha citados.',
    escreve: ['C:/Users/pessoa/projetos/projeto/src/componentes', 'C:/Users/pessoa/projetos/projeto/docs'],
  })
  const colegas = Array.from({ length: n }, (_, i) => colega(i + 1))
  const semAgent = prateleira.kits.filter(k => !k.ferramentas.includes('Agent')).map(k => k.id)
  const medidas = []
  for (const projeto of prateleira.projetos) {
    for (const tipo of prateleira.tipos) {
      const kits = [...new Set([...(tipo.kitPadrao ?? []), ...(opcao('--so-padrao') ? [] : semAgent)])]
      const skills = [...new Set(prateleira.kits.filter(k => kits.includes(k.id)).flatMap(k => k.skills ?? []))].filter(s => prateleira.aprovados.some(a => a.id === s))
      const ficha = { nome: 'motor-exemplo', descricao: 'Muda o código do projeto.', projeto: projeto.id, tipo: tipo.id, kits, skills, dossie }
      const { pesos } = montarTexto(ficha, prateleira, fatos, { relatorioLongo, time: { colegas } })
      medidas.push({ projeto: projeto.id, tipo: tipo.id, pesos })
    }
  }
  medidas.sort((a, b) => b.pesos.total - a.pesos.total)
  console.log(`${medidas.length} combinações, cada uma com ${opcao('--so-padrao') ? 'os kits padrão do tipo' : 'todos os kits sem Agent'} e ${n} colegas. As cinco maiores:`)
  for (const m of medidas.slice(0, 5)) console.log(`- ${m.projeto} + ${m.tipo}: ${linha(m.pesos)}`)
}
