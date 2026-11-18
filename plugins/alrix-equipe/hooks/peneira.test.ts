import { expect, test } from 'claude-code/testing'

import { mascarar, segredosEm } from './peneira.ts'

// Os segredos de exemplo são montados por partes, para este arquivo não carregar nada com cara de chave de verdade.
const junta = (...partes: string[]): string => partes.join('')
const MEIO = 'Zk3pQ9vLm2Xa7TrB5nWc'

const exemplos: { nome: string; texto: string; tipo: string; inicio: string }[] = [
  { nome: 'chave da Anthropic', texto: junta('sk', '-ant-', 'api03-', MEIO, 'x81'), tipo: 'chave da Anthropic', inicio: 'sk-ant-' },
  { nome: 'chave sk- comum', texto: junta('sk', '-', 'proj', '-', MEIO, '42'), tipo: 'chave de API (sk-)', inicio: 'sk-' },
  { nome: 'token do GitHub (ghp_)', texto: junta('gh', 'p_', MEIO, '9aQ'), tipo: 'token do GitHub', inicio: 'ghp_' },
  { nome: 'token do GitHub (github_pat_)', texto: junta('github', '_pat_', MEIO, '_7Gh2'), tipo: 'token do GitHub', inicio: 'github_pat_' },
  { nome: 'token do Slack', texto: junta('xo', 'xb-', '1234567890-', MEIO), tipo: 'token do Slack', inicio: 'xoxb-' },
  { nome: 'chave da AWS', texto: junta('AK', 'IA', 'ABCDEFGH', '12345678'), tipo: 'chave da AWS', inicio: 'AKIA' },
  { nome: 'chave do Google', texto: junta('AI', 'za', 'Sy', MEIO, 'Hq4Rt8Uv1Wy6Ab'), tipo: 'chave do Google', inicio: 'AIza' },
]

for (const e of exemplos) {
  test(`acha ${e.nome} no meio de uma frase e mostra só o começo`, () => {
    const texto = `Use isto: ${e.texto} e siga.`
    const achados = segredosEm(texto)
    expect(achados.length).toBe(1)
    expect(achados[0]?.tipo).toBe(e.tipo)
    expect(achados[0]?.amostra.startsWith(e.inicio)).toBe(true)
    expect(achados[0]?.amostra.endsWith('***')).toBe(true)
    expect(achados[0]?.amostra).not.toContain(MEIO)
    const limpo = mascarar(texto)
    expect(limpo).not.toContain(MEIO)
    expect(limpo.startsWith('Use isto: ')).toBe(true)
    expect(limpo.endsWith(' e siga.')).toBe(true)
  })
}

test('acha "Bearer" seguido de valor longo e deixa a palavra Bearer', () => {
  const valor = junta('abc123', 'DEF456', 'ghi789', 'JKL012')
  const texto = `curl -H "Authorization: Bearer ${valor}" https://exemplo.test`
  const achados = segredosEm(texto)
  expect(achados.map(a => a.tipo)).toEqual(['Bearer'])
  expect(achados[0]?.amostra).toBe('Bearer ***')
  const limpo = mascarar(texto)
  expect(limpo).toContain('Bearer ***')
  expect(limpo).not.toContain(valor)
  expect(limpo.endsWith('" https://exemplo.test')).toBe(true)
})

test('acha o bloco de chave privada inteiro, com começo e fim', () => {
  const corpo = junta('MIIEvQIBADANBgkq', 'hkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIB')
  const texto = ['antes', junta('-----BEGIN ', 'PRIVATE KEY-----'), corpo, junta('-----END ', 'PRIVATE KEY-----'), 'depois'].join('\n')
  const achados = segredosEm(texto)
  expect(achados).toEqual([{ tipo: 'chave privada', amostra: '[chave privada]' }])
  expect(mascarar(texto)).toBe('antes\n[chave privada]\ndepois')
})

test('bloco de chave privada cortado no meio também é mascarado até o fim do texto', () => {
  const texto = `veja\n${junta('-----BEGIN RSA ', 'PRIVATE KEY-----')}\nMIIEowIBAAKCAQEA`
  expect(mascarar(texto)).toBe('veja\n[chave privada]')
})

test('acha nome=valor quando o nome diz segredo e o valor é longo; o nome fica, o valor some', () => {
  const valor = junta('p4ssw0rd', 'Longa', '2026x')
  const casos = [`DB_PASSWORD=${valor}`, `senha: ${valor}`, `"api_key": "${valor}"`, `client_secret=${valor}`, `GITHUB_TOKEN=${valor}`]
  for (const texto of casos) {
    const achados = segredosEm(texto)
    expect(achados.length).toBe(1)
    expect(achados[0]?.tipo).toBe('nome e valor')
    expect(achados[0]?.amostra.endsWith('=***')).toBe(true)
    expect(mascarar(texto)).not.toContain(valor)
  }
  expect(mascarar(`export DB_PASSWORD=${valor} && ls`)).toBe('export DB_PASSWORD=*** && ls')
})

test('nome=valor com chave de prefixo conhecido dá um achado só, não dois', () => {
  const chave = junta('sk', '-ant-', 'api03-', MEIO, 'x81')
  const texto = `ANTHROPIC_API_KEY=${chave}`
  expect(segredosEm(texto).length).toBe(1)
  expect(mascarar(texto)).toBe('ANTHROPIC_API_KEY=sk-ant-***')
})

test('achados saem na ordem em que aparecem e mascarar troca todos', () => {
  const a = junta('gh', 'p_', MEIO, '9aQ')
  const b = junta('AK', 'IA', 'ABCDEFGH', '12345678')
  const texto = `primeiro ${a} depois ${b} fim`
  expect(segredosEm(texto).map(x => x.tipo)).toEqual(['token do GitHub', 'chave da AWS'])
  expect(mascarar(texto)).toBe('primeiro ghp_*** depois AKIA*** fim')
})

// O que a peneira NÃO pode acusar: é o que os agentes escrevem todo dia.
const SHA256 = junta('183efc56979333c8', '5a1b2c3d4e5f60718293a4b5c6d7e8f9', '0123456789abcdef')
const COMMIT = junta('4723b72', 'f9e8d7c6b5a4', '938271605f4e3d2c1b0a9f8e')
const UUID_SESSAO = junta('84546b87-', '1f84-4c12-', '98d4-fa39f7fd0f25')

test('impressão digital SHA-256, id de commit e UUID de sessão passam', () => {
  const textos = [
    `SHA-256 ${SHA256}`,
    `sha256sum: ${SHA256}  missao.md`,
    `commit ${COMMIT}`,
    `git push --force-with-lease=main:4723b72 origin bdecf0b:refs/heads/main`,
    `Chave: ext:servidor:${UUID_SESSAO}`,
    `sessão ${UUID_SESSAO}`,
    `tmux sessão ax-shell-claude-${UUID_SESSAO.slice(0, 8)}`,
  ]
  for (const texto of textos) {
    expect(segredosEm(texto)).toEqual([])
    expect(mascarar(texto)).toBe(texto)
  }
})

test('caminho de arquivo passa, mesmo com nome que lembra segredo', () => {
  const textos = [
    'C:/Users/pessoa/projetos/alrix-equipe/mod/hooks/peneira.ts',
    'C:\\Users\\pessoa\\.claude\\alrix-equipe\\sessoes\\b73e8d55-82b6-40cc-aacb-13dcd54f48b0\\relatorio.md',
    '/home/pessoa/.app-code/anexos/20261116-1900-ab12cd/pedido.md',
    '~/.claude/settings.json',
    'token_file=/home/pessoa/.config/app/token.txt',
    'SECRET_PATH=C:/Segredos/chaves/producao/leitura',
    'senha_arquivo: ./config/senha-do-banco.txt',
  ]
  for (const texto of textos) expect(segredosEm(texto)).toEqual([])
})

test('nome de variável sem valor passa, e o valor que é outra variável ou marcador também', () => {
  const textos = [
    'ANTHROPIC_API_KEY',
    'Defina ANTHROPIC_API_KEY antes de rodar.',
    'ANTHROPIC_API_KEY=',
    'ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY',
    'export GITHUB_TOKEN="${GITHUB_TOKEN}"',
    'password=<sua-senha-aqui>',
    'api_key=xxxxxxxxxxxxxxxx',
    'token=***',
    'não imprima o valor do token nem da senha',
  ]
  for (const texto of textos) expect(segredosEm(texto)).toEqual([])
})

test('valor curto ou só palavras passa; "Bearer" sem valor longo passa', () => {
  const textos = [
    'password=abc123',
    'senha: necessária para entrar',
    'password: authentication-required',
    'max_tokens=100000000000',
    'Bearer tokens são enviados no cabeçalho',
    'Bearer authentication-scheme-required',
    'o risk-assessment-for-the-whole-system-is-ready',
  ]
  for (const texto of textos) expect(segredosEm(texto)).toEqual([])
})

test('texto vazio e texto comum passam sem mudar', () => {
  expect(segredosEm('')).toEqual([])
  expect(mascarar('')).toBe('')
  const frase = 'Missão m-20261116-1900-abcdef gravada. Copie o arquivo pelo túnel e confira o SHA-256 dos dois lados.'
  expect(mascarar(frase)).toBe(frase)
})

test('chamar duas vezes dá o mesmo resultado (as expressões não guardam estado)', () => {
  const texto = `a ${junta('gh', 'p_', MEIO, '9aQ')} b`
  expect(segredosEm(texto)).toEqual(segredosEm(texto))
  expect(mascarar(texto)).toBe(mascarar(texto))
})
