#!/usr/bin/env node
// ALRIX Kit · instalador único. Um arquivo, só Node, sem dependência.
//
//   node instalar.mjs                 instala os plugins do kit e liga a barra de status e a janela de 400 mil
//   node instalar.mjs --simular       só mostra o que faria, sem gravar nada e sem rodar o claude
//   node instalar.mjs --desfazer      devolve tudo como estava e remove o que foi copiado
//   node instalar.mjs --ajuda         lista as opções
//
// O que ele grava, e só isso:
//   - os plugins do kit, pelo próprio comando `claude plugin install`;
//   - a barra de status em <pasta de configuração>/alrix-kit/barra;
//   - no settings.json: statusLine, subagentStatusLine e o autoCompactWindow de 400 mil (por modelo e geral).
//     Verbos, dicas e tema só entram quando a pessoa pede (--verbos, --dicas, --tema).
// Antes de mexer no settings.json faz uma cópia com data e hora; tudo o mais fica como está. Rodar de novo dá o
// mesmo resultado. O registro do que foi feito fica em <pasta de configuração>/alrix-kit/instalado.json, e ao
// lado dele fica uma cópia deste instalador, para desfazer mesmo sem a pasta do kit.
// A pasta de configuração é CLAUDE_CONFIG_DIR, ou ~/.claude quando a variável não existe.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const REPOSITORIO = 'alrixbr/alrix-kit';
const JANELA_PADRAO = 400_000;
const MODELOS_PADRAO = ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5'];
const PLUGINS_DO_KIT = ['alrix-base', 'alrix-equipe', 'alrix-prompt', 'astra']; // só se o kit não trouxer marketplace.json
const VERSAO_MINIMA_INSTALAR = '2.1.275'; // `claude plugin install <plugin> --marketplace <origem>`
const VERSAO_MINIMA_JANELA_POR_MODELO = '2.1.288'; // autoCompactWindow dentro de modelSettings

// ---------------------------------------------------------------------------------------------------------------
// Texto para a pessoa

const dizer = (texto = '') => console.log(texto);
const ok = (texto) => dizer(`  ✔ ${texto}`);
const nota = (texto) => dizer(`  • ${texto}`);
const aviso = (texto) => dizer(`  ! ${texto}`);
const titulo = (texto) => dizer(`\n${texto}`);

const AJUDA = `ALRIX Kit · instalador

Uso: node instalar.mjs [opções]

O que faz sem opção nenhuma:
  1. instala os plugins do kit (o astra só se o Codex estiver neste computador);
  2. copia a barra de status para dentro da pasta de configuração do Claude Code;
  3. guarda uma cópia do settings.json com data e hora e junta nele só a barra, a linha dos subagentes e a
     janela de 400 mil tokens por modelo. O resto do arquivo fica como estava.

Opções:
  --simular             só mostra o que faria; não grava nada e não roda o claude
  --desfazer            devolve o settings.json de antes, desinstala o que foi instalado e apaga o que foi copiado
  --plugins a,b,c       instala só estes plugins (padrão: todos os do kit)
  --sem a,b             deixa estes de fora
  --trocar-barra        troca a barra de status que você já tem pela do kit (sem isto, a sua fica)
  --verbos              troca os verbos que aparecem enquanto o Claude trabalha pelos do kit
  --dicas               acrescenta as dicas do kit à rotação de dicas
  --tema escuro|claro   instala o tema de cores do kit e o escolhe
  --janela N            janela de compactação em tokens (padrão 400000; vale de 100000 a 1000000)
  --trocar-janela       troca uma janela diferente que você já tenha guardado
  --modelos a,b         modelos que ganham a janela própria (padrão: ${MODELOS_PADRAO.join(', ')})
  --github dono/repo    pega os plugins de um repositório do GitHub em vez da pasta do kit
  --ajuda               mostra esta ajuda

A pasta de configuração é a da variável CLAUDE_CONFIG_DIR; sem ela, ~/.claude.`;

// ---------------------------------------------------------------------------------------------------------------
// Opções

function lerOpcoes(argv) {
  const o = {
    simular: false, desfazer: false, ajuda: false, trocarBarra: false, verbos: false, dicas: false, tema: null,
    janela: JANELA_PADRAO, trocarJanela: false, modelos: MODELOS_PADRAO, plugins: null, sem: [], github: null, erros: [],
  };
  const lista = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const valor = () => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) o.erros.push(`A opção ${a} precisa de um valor.`);
      return argv[i];
    };
    if (a === '--simular') o.simular = true;
    else if (a === '--desfazer') o.desfazer = true;
    else if (a === '--ajuda' || a === '-h' || a === '--help') o.ajuda = true;
    else if (a === '--trocar-barra') o.trocarBarra = true;
    else if (a === '--verbos') o.verbos = true;
    else if (a === '--dicas') o.dicas = true;
    else if (a === '--trocar-janela') o.trocarJanela = true;
    else if (a === '--tema') {
      const v = String(valor() ?? '').toLowerCase();
      if (v === 'escuro' || v === 'claro') o.tema = v;
      else o.erros.push('A opção --tema aceita "escuro" ou "claro".');
    } else if (a === '--janela') {
      const n = Math.floor(Number(String(valor() ?? '').replace(/k$/i, '000')));
      if (n >= 100_000 && n <= 1_000_000) o.janela = n;
      else o.erros.push('A opção --janela aceita um número de tokens entre 100000 e 1000000.');
    } else if (a === '--modelos') o.modelos = lista(valor());
    else if (a === '--plugins') o.plugins = lista(valor());
    else if (a === '--sem') o.sem = lista(valor());
    else if (a === '--github') o.github = valor();
    else o.erros.push(`Não conheço a opção ${a}. Rode com --ajuda para ver as que existem.`);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Pasta de configuração, arquivos e JSON

const pastaDeConfiguracao = () => {
  const definida = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  return definida ? resolve(definida) : join(homedir(), '.claude');
};
/** Caminho com barra comum: serve igual no PowerShell, no cmd e no bash, e não tropeça em "\U" ou "\n". */
const comBarra = (caminho) => String(caminho).replace(/\\/g, '/');

const dois = (n) => String(n).padStart(2, '0');
const carimbo = (d = new Date()) =>
  `${d.getFullYear()}${dois(d.getMonth() + 1)}${dois(d.getDate())}-${dois(d.getHours())}${dois(d.getMinutes())}${dois(d.getSeconds())}`;

const lerTexto = (caminho) => readFileSync(caminho, 'utf8');
const sha = (texto) => createHash('sha256').update(texto).digest('hex');
const copiaProfunda = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function igual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ca = Object.keys(a);
  const cb = Object.keys(b);
  return ca.length === cb.length && ca.every((c) => igual(a[c], b[c]));
}

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ler(obj, caminho) {
  let atual = obj;
  for (const c of caminho) {
    if (!ehObjeto(atual) || !(c in atual)) return { tem: false, valor: undefined };
    atual = atual[c];
  }
  return { tem: true, valor: atual };
}

/** Grava `valor` em `caminho`, criando o que faltar; devolve os caminhos que criou (do mais fundo para o mais raso). */
function gravar(obj, caminho, valor) {
  const criados = [];
  let atual = obj;
  caminho.slice(0, -1).forEach((c, i) => {
    if (!ehObjeto(atual[c])) {
      atual[c] = {};
      criados.unshift(caminho.slice(0, i + 1));
    }
    atual = atual[c];
  });
  atual[caminho[caminho.length - 1]] = copiaProfunda(valor);
  return criados;
}

function remover(obj, caminho, criados = []) {
  const pai = ler(obj, caminho.slice(0, -1));
  if (pai.tem && ehObjeto(pai.valor)) delete pai.valor[caminho[caminho.length - 1]];
  for (const c of criados) {
    const alvo = ler(obj, c);
    if (alvo.tem && ehObjeto(alvo.valor) && Object.keys(alvo.valor).length === 0) {
      const acima = ler(obj, c.slice(0, -1));
      if (acima.tem && ehObjeto(acima.valor)) delete acima.valor[c[c.length - 1]];
    }
  }
}

/** Lê o settings.json: { existe, texto, ajustes } ou { erro }. Arquivo vazio vale como {}. */
function lerAjustes(arquivo) {
  if (!existsSync(arquivo)) return { existe: false, texto: '', ajustes: {} };
  const texto = lerTexto(arquivo);
  if (!texto.trim()) return { existe: true, texto, ajustes: {} };
  try {
    const ajustes = JSON.parse(texto.replace(/^\uFEFF/, ''));
    if (!ehObjeto(ajustes)) return { erro: 'o conteúdo não é um objeto JSON' };
    return { existe: true, texto, ajustes };
  } catch (e) {
    return { erro: String(e.message || e) };
  }
}

function recuo(texto) {
  const m = /^\{\s*\n([ \t]+)"/.exec(texto.replace(/^\uFEFF/, ''));
  return m ? m[1] : '  ';
}

/** Grava por arquivo temporário e troca de nome: o settings.json nunca fica pela metade. */
function gravarAtomico(arquivo, texto) {
  mkdirSync(dirname(arquivo), { recursive: true });
  const temporario = `${arquivo}.alrix-${process.pid}.tmp`;
  writeFileSync(temporario, texto, 'utf8');
  renameSync(temporario, arquivo);
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code, Node e Codex

function versaoMaiorOuIgual(versao, minima) {
  const a = String(versao).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(minima).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const aspas = (arg) => (/[\s"&|<>^%]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : String(arg));

/** Roda o claude. Tenta direto; no Windows, se ele for um .cmd (instalação por npm), tenta de novo pelo shell. */
function claude(args) {
  let r = spawnSync('claude', args, { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  if (r.error && process.platform === 'win32') {
    r = spawnSync(['claude', ...args.map(aspas)].join(' '), { encoding: 'utf8', windowsHide: true, timeout: 180_000, shell: true });
  }
  return { status: r.status ?? 1, saida: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), semClaude: !!r.error };
}

function versaoDoClaude() {
  const r = claude(['--version']);
  if (r.semClaude || r.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(r.saida)?.[1] ?? null;
}

function temCodex() {
  const procura = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { stdio: 'ignore', windowsHide: true });
  return procura.status === 0 || existsSync(join(homedir(), '.codex'));
}

// ---------------------------------------------------------------------------------------------------------------
// O kit: de onde vêm os plugins e a barra

function lerKit(opcoes) {
  const arquivoMarketplace = join(AQUI, '.claude-plugin', 'marketplace.json');
  let marketplace = null;
  try {
    marketplace = JSON.parse(lerTexto(arquivoMarketplace));
  } catch { /* sem marketplace.json ao lado do instalador */ }
  const pastaBarra = join(AQUI, 'plugins', 'alrix-base', 'barra');
  const nomeMarketplace = marketplace?.name || 'alrix';
  const origem = opcoes.github || (marketplace ? AQUI : REPOSITORIO);
  const doKit = Array.isArray(marketplace?.plugins) ? marketplace.plugins.map((p) => p.name).filter(Boolean) : PLUGINS_DO_KIT;
  return { marketplace: nomeMarketplace, origem, ehPasta: !opcoes.github && !!marketplace, doKit, pastaBarra };
}

const ARQUIVOS_DA_BARRA = ['comum.mjs', 'limites.mjs', 'statusline.mjs', 'subagentes.mjs', 'paleta.json'];
const TEMAS = { escuro: { arquivo: 'alrix.json', nome: 'custom:alrix' }, claro: { arquivo: 'alrix-papel.json', nome: 'custom:alrix-papel' } };

function pluginsEscolhidos(opcoes, kit, comCodex) {
  const pedidos = opcoes.plugins ?? kit.doKit;
  const escolhidos = [];
  const fora = [];
  for (const nome of pedidos) {
    if (opcoes.sem.includes(nome)) fora.push({ nome, motivo: 'você pediu para deixar de fora' });
    else if (!kit.doKit.includes(nome)) fora.push({ nome, motivo: 'não existe neste kit' });
    else if (nome === 'astra' && !comCodex) fora.push({ nome, motivo: 'o Codex não está neste computador' });
    else escolhidos.push(nome);
  }
  return { escolhidos, fora };
}

// ---------------------------------------------------------------------------------------------------------------
// O que entra no settings.json

/**
 * Calcula o settings.json depois da instalação, sem gravar nada. `anterior` é o registro da instalação anterior
 * (ou null). Devolve { depois, alteracoes, mantidos }: cada alteração diz o que havia antes (para o --desfazer).
 */
function planejarAjustes(antes, opcoes, ctx) {
  const depois = copiaProfunda(antes);
  const alteracoes = [];
  const mantidos = [];
  const anteriores = new Map((ctx.anterior?.alteracoes ?? []).map((a) => [a.caminho.join('\u0000'), a]));

  /** `modo`: 'barra' (troca só com --trocar-barra, ou se já é a do kit), 'janela' (--trocar-janela), 'pedido' (a pessoa pediu). */
  const querer = (caminho, valor, modo, rotulo) => {
    const chave = caminho.join('\u0000');
    const atual = ler(depois, caminho);
    const registro = anteriores.get(chave);
    if (atual.tem && igual(atual.valor, valor)) {
      if (registro && igual(registro.depois, valor)) alteracoes.push(registro); // continua sendo nosso
      return;
    }
    let pode = !atual.tem || modo === 'pedido';
    if (atual.tem && modo === 'barra') pode = opcoes.trocarBarra || ehDoKit(atual.valor);
    if (atual.tem && modo === 'janela') pode = opcoes.trocarJanela;
    if (!pode) {
      mantidos.push({ rotulo, caminho, atual: atual.valor, motivo: modo });
      if (registro) alteracoes.push(registro); // não era mais nosso, mas o registro antigo segue valendo até o --desfazer
      return;
    }
    const novoAntes = registro && atual.tem && igual(atual.valor, registro.depois) ? registro : null;
    const criados = gravar(depois, caminho, valor);
    alteracoes.push({
      caminho,
      tinha: novoAntes ? novoAntes.tinha : atual.tem,
      antes: novoAntes ? novoAntes.antes : copiaProfunda(atual.valor),
      depois: copiaProfunda(valor),
      criados: novoAntes ? novoAntes.criados : criados,
    });
  };

  const barra = comBarra(ctx.pastaBarra);
  querer(['statusLine'], { type: 'command', command: `node "${barra}/statusline.mjs"`, refreshInterval: 20 }, 'barra', 'barra de status');
  querer(['subagentStatusLine'], { type: 'command', command: `node "${barra}/subagentes.mjs"` }, 'barra', 'linha dos subagentes');

  if (ctx.janelaPorModelo) {
    for (const modelo of opcoes.modelos) {
      querer(['modelSettings', modelo, 'autoCompactWindow'], opcoes.janela, 'janela', `janela de ${modelo}`);
    }
  }
  querer(['autoCompactWindow'], opcoes.janela, 'janela', 'janela de todos os modelos');

  if (opcoes.verbos) querer(['spinnerVerbs'], ctx.verbos, 'pedido', 'verbos');
  if (opcoes.dicas) {
    const atual = ler(depois, ['spinnerTipsOverride']);
    const valor = ehObjeto(atual.valor) ? { ...atual.valor, tips: uniao(atual.valor.tips, ctx.dicas.tips) } : ctx.dicas;
    querer(['spinnerTipsOverride'], valor, 'pedido', 'dicas');
  }
  if (opcoes.tema) querer(['theme'], TEMAS[opcoes.tema].nome, 'pedido', 'tema');

  // as alterações antigas que esta rodada não tocou continuam no registro
  const vistas = new Set(alteracoes.map((a) => a.caminho.join('\u0000')));
  for (const [chave, a] of anteriores) if (!vistas.has(chave)) alteracoes.push(a);
  return { depois, alteracoes, mantidos };
}

const uniao = (a, b) => [...(Array.isArray(a) ? a : []), ...b.filter((x) => !(Array.isArray(a) ? a : []).some((y) => igual(x, y)))];
const ehDoKit = (valor) => ehObjeto(valor) && /\/alrix-kit\/barra\/(statusline|subagentes)\.mjs/.test(comBarra(valor.command || ''));

const mostrarValor = (v) => (v === undefined ? '(não existe)' : JSON.stringify(v));

// ---------------------------------------------------------------------------------------------------------------
// Instalar

function instalar(opcoes) {
  const cfg = pastaDeConfiguracao();
  const arquivoAjustes = join(cfg, 'settings.json');
  const pastaKit = join(cfg, 'alrix-kit');
  const arquivoRegistro = join(pastaKit, 'instalado.json');
  const pastaBarra = join(pastaKit, 'barra');
  const kit = lerKit(opcoes);

  titulo(opcoes.simular ? 'ALRIX Kit · simulação (nada será gravado)' : 'ALRIX Kit · instalação');
  nota(`Pasta de configuração do Claude Code: ${comBarra(cfg)}`);

  if (!existsSync(kit.pastaBarra) || ARQUIVOS_DA_BARRA.some((a) => !existsSync(join(kit.pastaBarra, a)))) {
    aviso(`Não achei a barra de status do kit em ${comBarra(kit.pastaBarra)}. Rode este instalador de dentro da pasta inteira do kit.`);
    return 1;
  }

  const lido = lerAjustes(arquivoAjustes);
  if (lido.erro) {
    aviso(`O arquivo ${comBarra(arquivoAjustes)} não é um JSON válido (${lido.erro}). Não mexi em nada. Corrija o arquivo e rode de novo.`);
    return 1;
  }
  let registro = null;
  if (existsSync(arquivoRegistro)) {
    try {
      registro = JSON.parse(lerTexto(arquivoRegistro));
    } catch {
      aviso(`O registro ${comBarra(arquivoRegistro)} está ilegível. Apague a pasta ${comBarra(pastaKit)} se quiser começar do zero; não mexi em nada.`);
      return 1;
    }
  }

  const verbos = lerJson(join(kit.pastaBarra, 'opcoes', 'verbos.json'));
  const dicas = lerJson(join(kit.pastaBarra, 'opcoes', 'dicas.json'));
  if ((opcoes.verbos && !verbos) || (opcoes.dicas && !dicas)) {
    aviso('Não achei os arquivos de verbos ou dicas do kit (barra/opcoes). Não mexi em nada.');
    return 1;
  }

  const versao = opcoes.simular ? null : versaoDoClaude();
  if (!opcoes.simular) {
    if (!versao) {
      aviso('Não achei o Claude Code neste computador (o comando "claude" não respondeu). Instale-o e rode de novo.');
      aviso('No Windows: abra o PowerShell e rode  irm https://claude.ai/install.ps1 | iex');
      return 1;
    }
    if (!versaoMaiorOuIgual(versao, VERSAO_MINIMA_INSTALAR)) {
      aviso(`O Claude Code ${versao} é antigo demais: o kit precisa da ${VERSAO_MINIMA_INSTALAR} ou mais nova. Rode  claude update  e tente de novo.`);
      return 1;
    }
    ok(`Claude Code ${versao}`);
  }
  const janelaPorModelo = opcoes.simular ? true : versaoMaiorOuIgual(versao, VERSAO_MINIMA_JANELA_POR_MODELO);
  const contexto = { pastaBarra, janelaPorModelo, verbos, dicas, anterior: registro };

  // O que muda no settings.json, calculado já: a cópia de antes só se faz quando algo vai mudar.
  const planoInicial = planejarAjustes(lido.ajustes, opcoes, contexto);
  const { escolhidos, fora } = pluginsEscolhidos(opcoes, kit, temCodex());
  const instaladosAntes = ler(lido.ajustes, ['enabledPlugins']).valor ?? {};
  const algoMuda = !igual(planoInicial.depois, lido.ajustes) || escolhidos.some((n) => !(`${n}@${kit.marketplace}` in instaladosAntes));
  let copiaFeita = registro?.copia ?? null;
  if (!opcoes.simular && algoMuda && lido.existe && lido.texto.trim()) {
    const nomeCopia = `alrix-kit/copias/settings.json.${carimbo()}`;
    mkdirSync(join(cfg, 'alrix-kit', 'copias'), { recursive: true });
    copyFileSync(arquivoAjustes, join(cfg, nomeCopia));
    titulo('Cópia de segurança');
    ok(`Cópia do settings.json guardada em ${comBarra(join(cfg, nomeCopia))}`);
    if (!copiaFeita) copiaFeita = nomeCopia; // a primeira cópia é a "de antes" do --desfazer
  }

  // ---- plugins
  titulo('Plugins');
  for (const f of fora) nota(`${f.nome}: fica de fora (${f.motivo}).`);
  const origemTexto = kit.ehPasta ? comBarra(kit.origem) : kit.origem;
  const marketplaceJaTinha = ler(lido.ajustes, ['extraKnownMarketplaces', kit.marketplace]).tem;
  const novosPlugins = [];
  if (!escolhidos.length) nota('Nenhum plugin escolhido.');
  for (const nome of escolhidos) {
    const id = `${nome}@${kit.marketplace}`;
    const jaEstava = id in instaladosAntes;
    if (opcoes.simular) {
      nota(`${jaEstava ? 'já instalado, só conferiria' : 'instalaria'}: claude plugin install ${nome} --marketplace ${origemTexto} --scope user`);
      continue;
    }
    const r = claude(['plugin', 'install', nome, '--marketplace', kit.origem, '--scope', 'user']);
    if (r.status !== 0) {
      aviso(`${nome}: o Claude Code não conseguiu instalar. Ele disse: ${r.saida.split('\n').slice(-3).join(' / ') || '(sem mensagem)'}`);
      continue;
    }
    ok(jaEstava ? `${nome}: já estava instalado` : `${nome}: instalado`);
    if (!jaEstava) novosPlugins.push(nome);
    if (jaEstava && !kit.ehPasta) {
      const atualizou = claude(['plugin', 'update', id]);
      nota(atualizou.status === 0 ? `${nome}: conferi se há versão nova` : `${nome}: não consegui conferir versão nova (${atualizou.saida.split('\n')[0]})`);
    }
  }

  // ---- a barra: arquivos
  titulo('Barra de status');
  const aCopiar = ARQUIVOS_DA_BARRA.map((a) => ({ de: join(kit.pastaBarra, a), para: join(pastaBarra, a) }));
  const diferentes = aCopiar.filter((a) => !existsSync(a.para) || lerTexto(a.de) !== lerTexto(a.para));
  if (!diferentes.length) ok(`Os arquivos da barra já estão em ${comBarra(pastaBarra)}, iguais aos do kit.`);
  else {
    nota(`${opcoes.simular ? 'Copiaria' : 'Copio'} ${diferentes.length} arquivo(s) da barra para ${comBarra(pastaBarra)}: ${diferentes.map((a) => a.de.split(/[\\/]/).pop()).join(', ')}`);
    if (!opcoes.simular) {
      mkdirSync(pastaBarra, { recursive: true });
      for (const a of diferentes) copyFileSync(a.de, a.para);
    }
  }

  // ---- tema: o arquivo do tema vai para <pasta de configuração>/themes
  const arquivosCopiados = new Map((registro?.arquivos ?? []).map((a) => [a.destino, a]));
  const temasACopiar = [];
  if (opcoes.tema) {
    const t = TEMAS[opcoes.tema];
    const de = join(kit.pastaBarra, 'temas', t.arquivo);
    const para = join(cfg, 'themes', t.arquivo);
    const destino = comBarra(para);
    if (existsSync(para) && lerTexto(para) === lerTexto(de)) nota(`O tema ${t.arquivo} já está em ${destino}.`);
    else {
      const registrado = arquivosCopiados.get(destino);
      const existia = registrado ? registrado.existia : existsSync(para);
      const guardadoEm = registrado ? registrado.guardadoEm : existia ? `alrix-kit/copias/${t.arquivo}.${carimbo()}` : null;
      temasACopiar.push({ de, para, destino, existia, guardadoEm, jaRegistrado: !!registrado });
      nota(`${opcoes.simular ? 'Copiaria' : 'Copio'} o tema ${t.arquivo} para ${destino}${existia ? ' (o que existia fica guardado)' : ''}.`);
    }
  }

  // ---- settings.json
  titulo('settings.json');
  if (!janelaPorModelo) nota(`O Claude Code ${versao} ainda não guarda a janela por modelo (isso vem na ${VERSAO_MINIMA_JANELA_POR_MODELO}): fica só a janela geral.`);
  // Depois dos plugins, o Claude Code já pode ter escrito no settings.json (enabledPlugins): lê de novo.
  const relido = opcoes.simular ? lido : lerAjustes(arquivoAjustes);
  if (relido.erro) {
    aviso(`O arquivo ${comBarra(arquivoAjustes)} ficou ilegível depois de instalar os plugins (${relido.erro}). Não mexi mais nele.`);
    return 1;
  }
  const plano = planejarAjustes(relido.ajustes, opcoes, contexto);
  for (const m of plano.mantidos) {
    if (m.motivo === 'barra') aviso(`Você já tem ${m.rotulo} própria; mantive a sua. Para trocar pela do kit, rode de novo com --trocar-barra (o --desfazer devolve a sua).`);
    else aviso(`Você já tem ${m.rotulo} com outro valor (${mostrarValor(m.atual)}); mantive o seu. Para trocar, use --trocar-janela.`);
  }
  const mudou = !igual(plano.depois, relido.ajustes);
  if (!mudou) ok('O settings.json já tem tudo o que o kit liga. Nada a mudar.');
  else {
    dizer('  O que muda no settings.json (só estas chaves; o resto fica como está):');
    for (const a of plano.alteracoes) {
      const atual = ler(relido.ajustes, a.caminho);
      if (atual.tem && igual(atual.valor, a.depois)) continue;
      dizer(`    ${a.caminho.join('.')}`);
      dizer(`      antes:  ${mostrarValor(atual.valor)}`);
      dizer(`      depois: ${mostrarValor(a.depois)}`);
    }
  }
  if (opcoes.simular) {
    titulo('Simulação terminada. Nada foi gravado. Para instalar de verdade, rode sem --simular.');
    return 0;
  }

  // ---- gravar
  if (mudou) {
    gravarAtomico(arquivoAjustes, `${JSON.stringify(plano.depois, null, recuo(relido.texto))}\n`);
    ok('settings.json atualizado.');
  }
  for (const c of temasACopiar) {
    if (!c.jaRegistrado && c.existia && c.guardadoEm) {
      mkdirSync(dirname(join(cfg, c.guardadoEm)), { recursive: true });
      copyFileSync(c.para, join(cfg, c.guardadoEm));
    }
    mkdirSync(dirname(c.para), { recursive: true });
    copyFileSync(c.de, c.para);
    arquivosCopiados.set(c.destino, { destino: c.destino, existia: c.existia, guardadoEm: c.guardadoEm });
  }

  const final = lerAjustes(arquivoAjustes);
  const novoRegistro = {
    versao: 1,
    atualizadoEm: new Date().toISOString(),
    pastaDeConfiguracao: comBarra(cfg),
    copia: copiaFeita,
    settingsExistia: registro ? registro.settingsExistia : lido.existe,
    settingsTextoVazio: registro ? registro.settingsTextoVazio ?? null : lido.existe && !lido.texto.trim() ? lido.texto : null,
    barra: comBarra(pastaBarra),
    marketplace: { nome: kit.marketplace, origem: origemTexto, adicionadoPorNos: registro?.marketplace?.adicionadoPorNos ?? !marketplaceJaTinha },
    plugins: [...new Set([...(registro?.plugins ?? []), ...novosPlugins])],
    alteracoes: plano.alteracoes,
    arquivos: [...arquivosCopiados.values()],
    sha256DoSettings: final.erro ? null : sha(final.texto),
  };
  mkdirSync(pastaKit, { recursive: true });
  gravarAtomico(arquivoRegistro, `${JSON.stringify(novoRegistro, null, 2)}\n`);
  // Uma cópia deste instalador fica junto do registro: é por ela que a pessoa desfaz, mesmo sem a pasta do kit
  // (quem instalou pela linha do irm não tem a pasta).
  const copiaDoInstalador = join(pastaKit, 'instalar.mjs');
  const esteArquivo = fileURLToPath(import.meta.url);
  if (resolve(esteArquivo) !== resolve(copiaDoInstalador)) copyFileSync(esteArquivo, copiaDoInstalador);

  titulo('Pronto.');
  nota('Abra uma sessão nova do Claude Code para ver a barra e a janela de compactação.');
  nota(`Para desfazer tudo:  node "${comBarra(copiaDoInstalador)}" --desfazer`);
  return 0;
}


function lerJson(caminho) {
  try {
    return JSON.parse(lerTexto(caminho));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Desfazer

function desfazer(opcoes) {
  const cfg = pastaDeConfiguracao();
  const arquivoAjustes = join(cfg, 'settings.json');
  const pastaKit = join(cfg, 'alrix-kit');
  const arquivoRegistro = join(pastaKit, 'instalado.json');

  titulo(opcoes.simular ? 'ALRIX Kit · desfazer, simulação (nada será gravado)' : 'ALRIX Kit · desfazer');
  nota(`Pasta de configuração do Claude Code: ${comBarra(cfg)}`);
  if (!existsSync(arquivoRegistro)) {
    nota('Não achei o registro de uma instalação do kit nesta pasta de configuração. Não há nada a desfazer.');
    return 0;
  }
  let registro;
  try {
    registro = JSON.parse(lerTexto(arquivoRegistro));
  } catch {
    aviso(`O registro ${comBarra(arquivoRegistro)} está ilegível. Não mexi em nada.`);
    return 1;
  }

  // ---- plugins
  titulo('Plugins');
  const instalados = registro.plugins ?? [];
  if (!instalados.length) nota('O kit não instalou plugin nesta pasta de configuração.');
  const marketplace = registro.marketplace?.nome || 'alrix';
  for (const nome of instalados) {
    if (opcoes.simular) {
      nota(`desinstalaria: claude plugin uninstall ${nome}@${marketplace} --scope user`);
      continue;
    }
    const r = claude(['plugin', 'uninstall', `${nome}@${marketplace}`, '--scope', 'user']);
    if (r.status === 0) ok(`${nome}: desinstalado`);
    else aviso(`${nome}: o Claude Code não conseguiu desinstalar (${r.saida.split('\n')[0] || 'sem mensagem'}). Faça pelo /plugin se ele ainda aparecer.`);
  }
  if (registro.marketplace?.adicionadoPorNos) {
    const ativos = Object.keys(ler(lerAjustes(arquivoAjustes).ajustes ?? {}, ['enabledPlugins']).valor ?? {}).filter((id) => id.endsWith(`@${marketplace}`) && !instalados.some((n) => id === `${n}@${marketplace}`));
    if (ativos.length) nota(`O marketplace "${marketplace}" fica: ainda há plugins dele instalados (${ativos.join(', ')}).`);
    else if (opcoes.simular) nota(`removeria o marketplace "${marketplace}", que o kit tinha acrescentado`);
    else {
      const r = claude(['plugin', 'marketplace', 'remove', marketplace]);
      if (r.status === 0) ok(`Marketplace "${marketplace}" removido`);
      else aviso(`Não consegui remover o marketplace "${marketplace}" (${r.saida.split('\n')[0] || 'sem mensagem'}).`);
    }
  }

  // ---- settings.json
  titulo('settings.json');
  const lido = lerAjustes(arquivoAjustes);
  if (lido.erro) {
    aviso(`O arquivo ${comBarra(arquivoAjustes)} não é um JSON válido (${lido.erro}). Não mexi nele; a cópia de antes está em ${registro.copia ? comBarra(join(cfg, registro.copia)) : '(não houve cópia)'}.`);
    return 1;
  }
  const ajustes = copiaProfunda(lido.ajustes);
  for (const a of [...(registro.alteracoes ?? [])].reverse()) {
    const nome = a.caminho.join('.');
    const atual = ler(ajustes, a.caminho);
    if (!atual.tem || !igual(atual.valor, a.depois)) {
      if (atual.tem) aviso(`${nome}: você mudou depois da instalação; deixei como está.`);
      continue;
    }
    dizer(`  ${nome}`);
    dizer(`    ${mostrarValor(atual.valor)}`);
    dizer(`    volta a: ${a.tinha ? mostrarValor(a.antes) : '(não existia)'}`);
    if (a.tinha) gravar(ajustes, a.caminho, a.antes);
    else remover(ajustes, a.caminho, a.criados ?? []);
  }

  // O que o próprio comando de plugins do Claude Code deixa vazio ao desinstalar não conta como mudança da pessoa.
  const copia = registro.copia ? join(cfg, registro.copia) : null;
  const textoDeAntes = copia && existsSync(copia) ? lerTexto(copia) : null;
  let antesDaInstalacao = {};
  if (textoDeAntes !== null) {
    try {
      antesDaInstalacao = JSON.parse(textoDeAntes.replace(/^\uFEFF/, ''));
    } catch { antesDaInstalacao = null; }
  }
  for (const chave of ['enabledPlugins', 'extraKnownMarketplaces']) {
    if (ehObjeto(ajustes[chave]) && Object.keys(ajustes[chave]).length === 0 && !(chave in (antesDaInstalacao ?? {}))) delete ajustes[chave];
  }
  const restauraBytes = textoDeAntes !== null && antesDaInstalacao !== null && igual(antesDaInstalacao, ajustes);
  const ficouVazio = Object.keys(ajustes).length === 0;
  if (opcoes.simular) {
    nota(restauraBytes ? 'Depois disso o settings.json fica idêntico à cópia de antes.' : 'O settings.json ficaria sem as chaves do kit.');
  } else if (restauraBytes) {
    gravarAtomico(arquivoAjustes, textoDeAntes);
    ok('settings.json devolvido, byte a byte, como estava antes da instalação.');
  } else if (ficouVazio && registro.settingsTextoVazio != null) {
    gravarAtomico(arquivoAjustes, registro.settingsTextoVazio);
    ok('settings.json devolvido vazio, como estava antes da instalação.');
  } else if (ficouVazio && registro.settingsExistia === false) {
    rmSync(arquivoAjustes, { force: true });
    ok('settings.json removido: ele não existia antes da instalação.');
  } else if (!igual(ajustes, lido.ajustes)) {
    gravarAtomico(arquivoAjustes, `${JSON.stringify(ajustes, null, recuo(lido.texto))}\n`);
    ok('settings.json devolvido sem as chaves do kit (o resto ficou como está).');
    if (copia) nota(`A cópia de antes continua em ${comBarra(copia)}.`);
  } else nota('O settings.json não tinha mais nada do kit.');

  // ---- arquivos copiados
  titulo('Arquivos copiados');
  for (const a of registro.arquivos ?? []) {
    const guardado = a.guardadoEm ? join(cfg, a.guardadoEm) : null;
    if (opcoes.simular) nota(`${a.existia ? 'devolveria' : 'removeria'} ${a.destino}`);
    else if (a.existia && guardado && existsSync(guardado)) {
      copyFileSync(guardado, a.destino);
      ok(`${a.destino}: voltou o que existia antes`);
    } else {
      rmSync(a.destino, { force: true });
      ok(`${a.destino}: removido`);
    }
  }
  const pastaBarra = join(pastaKit, 'barra');
  if (opcoes.simular) nota(`removeria a pasta ${comBarra(pastaKit)} (barra, registro e cópias)`);
  else {
    const guardarCopias = !restauraBytes && existsSync(join(pastaKit, 'copias'));
    rmSync(pastaBarra, { recursive: true, force: true });
    rmSync(arquivoRegistro, { force: true });
    rmSync(join(pastaKit, 'instalar.mjs'), { force: true });
    if (guardarCopias) nota(`Guardei as cópias em ${comBarra(join(pastaKit, 'copias'))} porque o settings.json mudou depois da instalação.`);
    else {
      try {
        rmSync(pastaKit, { recursive: true, force: true });
      } catch {
        nota(`Não consegui apagar a pasta ${comBarra(pastaKit)} (ela está em uso). Pode apagar à mão: está vazia.`);
      }
    }
    ok('Barra copiada e registro removidos.');
    const temas = join(cfg, 'themes');
    if (existsSync(temas) && readdirSync(temas).length === 0) rmSync(temas, { recursive: true, force: true });
  }
  titulo(opcoes.simular ? 'Simulação terminada. Nada foi gravado.' : 'Tudo desfeito. Abra uma sessão nova do Claude Code para ver a barra padrão de volta.');
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------

function principal() {
  const opcoes = lerOpcoes(process.argv.slice(2));
  if (opcoes.ajuda) {
    dizer(AJUDA);
    return 0;
  }
  if (opcoes.erros.length) {
    for (const e of opcoes.erros) aviso(e);
    dizer('\nRode  node instalar.mjs --ajuda  para ver as opções.');
    return 1;
  }
  const maior = Number(process.versions.node.split('.')[0]);
  if (maior < 18) {
    aviso(`O Node ${process.versions.node} é antigo demais: o instalador precisa do Node 18 ou mais novo. Baixe o atual em https://nodejs.org`);
    return 1;
  }
  try {
    return opcoes.desfazer ? desfazer(opcoes) : instalar(opcoes);
  } catch (e) {
    aviso(`Algo deu errado e parei: ${e?.message || e}`);
    dizer('  O settings.json só é gravado no fim, de uma vez, por isso não deve ter ficado pela metade. Se ficou dúvida, a cópia de antes está na pasta alrix-kit/copias da pasta de configuração.');
    return 1;
  }
}

process.exitCode = principal();
