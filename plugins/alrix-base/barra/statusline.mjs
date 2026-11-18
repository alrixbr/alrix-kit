// ALRIX · linha de status do Claude Code.
// Contrato: code.claude.com/docs/en/statusline (JSON no stdin, uma linha por linha no stdout, largura em COLUMNS).
//
//   ΛLRIX  │ Fable 5.2 xhigh │ meu-projeto main ±3 ↑1 │ ━━━━────── 184k/400k │ cache 92% · 48 min │ +120 −8
//   Limite │ 5 h ━━━━━━━━ 23% até 01:40 │ semana ━━━━━━━━ 61% até ter 05:00
//   Equipe │ ● revisor  Sonnet 5.5 · alto  há 17 min │ modo aviso          (só em sessão com time do alrix-equipe)
//
// Primeira linha: a sessão. A ordem é a prioridade: o que não cabe sai do fim; marca, modelo e pasta ficam.
// Segunda linha: os limites do plano (só aparece para quem tem plano com limite). A conta é a que está em uso.
// Terceira em diante: o time do plugin alrix-equipe, quando há um na sessão.
// Cor só onde pede atenção: tudo que está normal fica na tinta, âmbar avisa, vermelho é o limite.
// Sem rede. O git só roda quando a pasta é um repositório, e o resultado vale por 5 s.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  NEGRITO, RST, TRACO_VAZIO, ajustesDaPessoa, largura, lerEntrada, lerJson, marca, milhares, pastaDeConfiguracao, pintores,
  temaAtual,
} from './comum.mjs';
import { barra, faixa, quando } from './limites.mjs';

// O rótulo que abre cada linha (a marca, "Limite") ocupa a mesma largura, para o primeiro fio das linhas cair
// na mesma coluna. É a largura de "Equipe", o rótulo da linha do time.
const LARGURA_ROTULO = 6;
const rotulo = (texto) => texto + ' '.repeat(Math.max(0, LARGURA_ROTULO - largura(texto)));
// A pasta de dados do plugin alrix-equipe, dentro da pasta de configuração do Claude Code. O plugin publica ali o
// time de cada sessão, e esta barra deixa ali o sinal de que está de pé (ver linhasEquipe).
const EQUIPE = process.env.ALRIX_EQUIPE_DIR || join(pastaDeConfiguracao(), 'alrix-equipe');
const SINAL_A_CADA_MS = 60_000;
const GLIFO_EQUIPE = { rodando: '●', pronto: '○', terminou: '✓', alerta: '▲' };
const GIT_VALE_MS = 5000;
const CELULAS = 10;

function temRepositorio(pasta) {
  let atual = resolve(pasta);
  for (;;) {
    if (existsSync(join(atual, '.git'))) return true;
    const acima = dirname(atual);
    if (acima === atual) return false;
    atual = acima;
  }
}

/** Branch, arquivos mexidos e distância do remoto, numa chamada só do git. */
function lerGit(pasta, sessao) {
  if (!temRepositorio(pasta)) return null;
  const guardado = join(tmpdir(), `alrix-statusline-${String(sessao || 'x').replace(/[^\w-]/g, '')}.json`);
  const antes = lerJson(guardado);
  if (antes && antes.pasta === pasta && Date.now() - antes.em < GIT_VALE_MS) return antes.git;

  let git = null;
  try {
    const saida = execFileSync(
      'git', ['-C', pasta, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    git = { branch: '', mexidos: 0, frente: 0, atras: 0 };
    let commit = '';
    for (const linha of saida.split('\n')) {
      if (linha.startsWith('# branch.head ')) git.branch = linha.slice(14).trim();
      else if (linha.startsWith('# branch.oid ')) commit = linha.slice(13, 20);
      else if (linha.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(linha);
        if (m) [git.frente, git.atras] = [Number(m[1]), Number(m[2])];
      } else if (linha && !linha.startsWith('#')) git.mexidos += 1;
    }
    if (git.branch === '(detached)') git.branch = commit;
  } catch {
    git = null; // sem git instalado ou pasta que o git recusa: a barra segue sem o ramo
  }
  try {
    writeFileSync(guardado, JSON.stringify({ pasta, em: Date.now(), git }));
  } catch { /* sem cache, segue */ }
  return git;
}

function segmentoModelo(cor, dados) {
  const nome = String(dados.model?.display_name || '?');
  let texto = cor.ink(nome.replace(/\s*\(.*$/, ''));
  if (nome.includes('(1M')) texto += ` ${cor.muted('1M')}`;
  if (dados.effort?.level) texto += ` ${cor.muted(dados.effort.level)}`;
  if (dados.fast_mode) texto += ` ${cor.amber('rápido')}`;
  return texto;
}

function segmentoPasta(cor, dados) {
  const pasta = dados.workspace?.current_dir || dados.cwd || process.cwd();
  const nome = resolve(pasta) === resolve(homedir()) ? '~' : basename(pasta) || pasta;
  let texto = cor.ink(nome.replace(/[\x00-\x1f\x7f]/g, '?'));
  const git = lerGit(pasta, dados.session_id);
  if (git?.branch) {
    const branch = git.branch.length > 26 ? `${git.branch.slice(0, 25)}…` : git.branch;
    texto += ` ${cor.muted(branch)}`;
    if (git.mexidos > 0) texto += ` ${cor.amber(`±${git.mexidos}`)}`;
    if (git.frente > 0) texto += ` ${cor.ink2(`↑${git.frente}`)}`;
    if (git.atras > 0) texto += ` ${cor.amber(`↓${git.atras}`)}`;
  }
  return texto;
}

/** Uma janela de compactação válida (100 mil a 1 milhão de tokens), ou 0. O texto "auto" e o lixo dão 0. */
function janelaValida(valor) {
  const n = Math.floor(Number(valor));
  return n >= 100_000 && n <= 1_000_000 ? n : 0;
}

/**
 * O contexto medido contra a janela de compactação. A ordem é a do Claude Code: a variável de ambiente
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW, a janela guardada para o modelo (modelSettings), a janela de todos os modelos
 * (autoCompactWindow) e, sem nenhuma, a janela do próprio modelo. Nunca passa da janela do modelo.
 */
function segmentoContexto(cor, dados, ajustes) {
  const janelaDoModelo = Math.floor(Number(dados.context_window?.context_window_size) || 0);
  let janela = janelaValida(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
    || janelaValida(ajustes?.modelSettings?.[dados.model?.id]?.autoCompactWindow)
    || janelaValida(ajustes?.autoCompactWindow) || janelaDoModelo;
  if (janelaDoModelo > 0 && janelaDoModelo < janela) janela = janelaDoModelo;
  if (!(janela > 0)) return null;

  const usado = Math.floor(Number(dados.context_window?.total_input_tokens) || 0)
    + Math.floor(Number(dados.context_window?.total_output_tokens) || 0);
  const pct = Math.min(100, Math.floor((usado * 100) / janela));
  const cheias = usado > 0 ? Math.max(1, Math.round((pct * CELULAS) / 100)) : 0;
  const pinta = faixa(cor, pct);
  return `${pinta('━'.repeat(cheias))}${cor.lineSoft(TRACO_VAZIO.repeat(CELULAS - cheias))} `
    + `${pinta(milhares(usado))}${cor.muted(`/${milhares(janela)}`)}`;
}

/** A linha dos limites do plano: as duas janelas (5 horas e semana), ao vivo, como o Claude Code as manda. */
function linhaLimites(cor, dados, fio, cabe) {
  const agora = Date.now();
  const aoVivo = (janela) => (janela?.used_percentage == null ? null : {
    pct: Math.floor(janela.used_percentage), volta: janela.resets_at > 0 ? janela.resets_at * 1000 : undefined,
  });
  const cinco = aoVivo(dados.rate_limits?.five_hour);
  const semana = aoVivo(dados.rate_limits?.seven_day);
  if (!cinco && !semana) return null;

  const janela = (nome, lida, comVolta) => {
    if (!lida) return null;
    const pct = Math.round(lida.pct);
    const volta = comVolta && lida.volta ? cor.muted(` até ${quando(lida.volta, agora, true)}`) : '';
    return `${cor.muted(nome)} ${barra(cor, pct, 8)} ${faixa(cor, pct)(`${pct}%`)}${volta}`;
  };

  // O que não cabe sai nesta ordem: a volta da semana, depois a volta das 5 h.
  for (let voltas = 2; ; voltas -= 1) {
    const partes = [
      rotulo(`${NEGRITO}${cor.ink('Limite')}${RST}`),
      janela('5 h', cinco, voltas >= 1),
      janela('semana', semana, voltas >= 2),
    ].filter(Boolean);
    const texto = partes.join(fio);
    if (largura(texto) <= cabe || voltas === 0) return texto;
  }
}

/** "menos de 1 min", "14 min", "1 h 05 min": as mesmas palavras do plugin alrix-equipe. */
function haQuanto(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Um texto sem cor cortado para caber em `cabe` colunas, com reticências; vazio quando não cabe nada. */
function corta(texto, cabe) {
  const letras = [...texto];
  if (letras.length <= cabe) return texto;
  return cabe <= 1 ? '' : `${letras.slice(0, cabe - 1).join('')}…`;
}

/**
 * O time do plugin alrix-equipe, uma linha por especialista, logo abaixo dos limites:
 *
 *   Equipe │ ● revisor     Sonnet 5.5 · alto   há 17 min │ modo aviso
 *          │ ▲ conferente  Sonnet 5.5 · baixo  terminou em 2 min · 3 escritas recusadas
 *
 * A barra de estado é a única que desenha acima da linha de modo do Claude Code; por isso o plugin publica o time
 * da sessão em sessoes/<sessão>/tela.json e quem desenha é esta barra. O plugin só pede o desenho (naBarra) depois
 * de ver o sinal barra.json, que é renovado aqui no máximo uma vez por minuto; sem a pasta do plugin, nada é
 * escrito e nada é desenhado. O que não cabe na largura sai do fim: o modo, o alerta, o estado.
 */
function linhasEquipe(cor, dados, fio, cabe) {
  if (!existsSync(EQUIPE)) return [];
  const agora = Date.now();
  const sinal = join(EQUIPE, 'barra.json');
  let fresco = false;
  try {
    fresco = agora - statSync(sinal).mtimeMs < SINAL_A_CADA_MS;
  } catch { /* primeira vez */ }
  if (!fresco) {
    try {
      writeFileSync(sinal, JSON.stringify({ v: 1, em: agora }));
    } catch { /* sem o sinal, o plugin desenha o time sob o campo de texto */ }
  }

  const sessao = String(dados.session_id || '');
  if (!/^[\w-]{6,80}$/.test(sessao)) return [];
  const tela = lerJson(join(EQUIPE, 'sessoes', sessao, 'tela.json'));
  if (!tela?.naBarra || !Array.isArray(tela.linhas)) return [];
  const limpo = (valor) => String(valor ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
  const linhas = tela.linhas.filter((l) => l && typeof l.nome === 'string').slice(0, 6);
  if (!linhas.length) return [];

  const larguraNome = Math.max(...linhas.map((l) => [...limpo(l.nome)].length)) + 2;
  const larguraMotor = Math.max(...linhas.map((l) => [...limpo(l.motor)].length)) + 2;
  const semRotulo = ' '.repeat(LARGURA_ROTULO);
  const pinta = { rodando: cor.accent, pronto: cor.muted, terminou: cor.sage, alerta: cor.amber };

  const saida = linhas.map((l, i) => {
    const cabeca = `${i === 0 ? rotulo(`${NEGRITO}${cor.ink('Equipe')}${RST}`) : semRotulo}${fio}`;
    let sobra = cabe - LARGURA_ROTULO - 3 - 2; // o rótulo, o fio, a marca e o espaço dela
    const nome = corta(limpo(l.nome).padEnd(larguraNome), sobra);
    sobra -= [...nome].length;
    const motor = corta(limpo(l.motor).padEnd(larguraMotor), sobra);
    sobra -= [...motor].length;
    // de quem trabalha, o tempo é refeito aqui: a barra roda de novo a cada 20 s, mesmo com a sessão parada
    const estado = corta(Number(l.desde) > 0 ? `há ${haQuanto(agora - l.desde)}${limpo(l.sufixo)}` : limpo(l.estado), sobra);
    sobra -= [...estado].length;
    const alerta = l.alerta && [...limpo(l.alerta)].length + 3 <= sobra ? ` · ${limpo(l.alerta)}` : '';
    sobra -= [...alerta].length;
    const modo = i === 0 && tela.modo && [...limpo(tela.modo)].length + 3 <= sobra ? `${fio}${cor.muted(limpo(tela.modo))}` : '';

    const rodando = l.marca === 'rodando';
    const marcaDele = (pinta[l.marca] || cor.muted)(GLIFO_EQUIPE[l.marca] || '○');
    return `${cabeca}${marcaDele} ${rodando ? `${NEGRITO}${cor.ink(nome)}${RST}` : cor.ink(nome)}${cor.muted(motor)}`
      + `${(rodando ? cor.ink2 : cor.muted)(estado)}${alerta ? cor.amber(alerta) : ''}${modo}`;
  });
  if (Number(tela.resto) > 0) {
    const faltam = corta(`+ ${Math.floor(Number(tela.resto))} no time · /equipe mostra todos`, cabe - LARGURA_ROTULO - 3);
    saida.push(`${semRotulo}${fio}${cor.muted(faltam)}`);
  }
  return saida;
}

/** Quanto do pedido veio do cache e quanto falta para ele esfriar (pausa maior reprocessa tudo). */
function segmentoCache(cor, dados) {
  const cache = dados.prompt_cache;
  if (cache?.hit_ratio == null) return null;
  const acerto = Math.floor(cache.hit_ratio * 100);
  const pinta = acerto >= 80 ? cor.ink2 : acerto >= 50 ? cor.amber : cor.del;
  let texto = `${cor.muted('cache')} ${pinta(`${acerto}%`)}`;
  const agora = Date.now() / 1000;
  if (cache.warm && cache.expires_at > agora) {
    const minutos = Math.floor((cache.expires_at - agora) / 60);
    texto += (minutos < 5 ? cor.amber : cor.muted)(` · ${minutos} min`);
  } else {
    texto += cor.amber(' · frio');
  }
  return texto;
}

function segmentoCusto(cor, dados) {
  const custo = Number(dados.cost?.total_cost_usd) || 0;
  return custo > 0 ? cor.muted(`US$ ${custo.toFixed(2).replace('.', ',')}`) : null;
}

function segmentoLinhas(cor, dados) {
  const mais = Number(dados.cost?.total_lines_added) || 0;
  const menos = Number(dados.cost?.total_lines_removed) || 0;
  return mais + menos > 0 ? `${cor.sage(`+${mais}`)} ${cor.del(`−${menos}`)}` : null;
}

const dados = await lerEntrada();
const ajustes = lerJson(ajustesDaPessoa());
const cor = pintores(temaAtual(ajustes));

const fio = cor.lineSoft(' │ ');
const cabe = Math.max(20, (Number(process.env.COLUMNS) || 200) - 4);

let linha = marca(cor);
try {
  const segmentos = [
    rotulo(marca(cor)),
    segmentoModelo(cor, dados),
    segmentoPasta(cor, dados),
    segmentoContexto(cor, dados, ajustes),
    segmentoCache(cor, dados),
    segmentoCusto(cor, dados),
    segmentoLinhas(cor, dados),
  ].filter(Boolean);

  for (;;) {
    linha = segmentos.join(fio);
    if (largura(linha) <= cabe || segmentos.length <= 3) break;
    segmentos.pop();
  }
} catch { /* uma linha de status nunca derruba a sessão: fica só a marca */ }

let limites = null;
try {
  limites = linhaLimites(cor, dados, fio, cabe);
} catch { /* sem a linha dos limites, a primeira segue */ }

let equipe = [];
try {
  equipe = linhasEquipe(cor, dados, fio, cabe);
} catch { /* sem o time, as linhas de cima seguem */ }
console.log([linha, limites, ...equipe].filter(Boolean).join('\n'));
