// Contrato do alrix-equipe: os tipos que o núcleo (hooks/), a prateleira (prateleira/* no plugin e a
// prateleira da pessoa, em <pasta do Claude Code>/alrix-equipe/prateleira) e os roteiros (scripts/*.mjs) têm em
// comum. Quem escreve dados segue este arquivo; quem escreve código lê os dados por ele.

export type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
/** Esta edição só trabalha neste computador ("pc"); "vps" segue no formato para a régua recusar com o motivo. */
export type Destino = 'pc' | 'vps'

/** Uma regra sempre vem com o motivo; o escopo diz onde ela vale. */
export type Regra = { regra: string; motivo: string; escopo?: string }

// ------------------------------------------------------------------- motores

/** Quem executa um especialista: o Claude Code (ajudante da sessão) ou o Codex (processo à parte). */
export type MotorId = 'claude' | 'codex'

export type ModeloDef = {
  /** Como o motor chama o modelo: "sonnet", "opus", "fable", "haiku", "gpt-6.2-astra", "gpt-6.2-sol". */
  id: string
  nome: string
  quandoUsar: string
  // Quando o modelo pede o cartão não é campo da prateleira: a regra é do código (cartaoSempreDe, em ficha.ts),
  // decisão do dono de 12/11/2026. Os antigos campos "cartao" e "esforcosComCartao" não são lidos.
  esforcos: Esforco[]
  /** O modelo usado quando a ficha não diz nenhum. Um só em toda a prateleira. */
  padrao?: boolean
}

/** prateleira/motores.json: { "motores": Motor[] } */
export type Motor = { id: MotorId; nome: string; modelos: ModeloDef[] }

// ---------------------------------------------------------------- prateleira

/** prateleira/projetos/<id>.json */
export type Projeto = {
  /** Igual ao nome do arquivo, sem .json. Minúsculas, dígitos e hífen. */
  id: string
  nome: string
  /** Uma ou duas frases: o que é e para quem. */
  resumo: string
  /** AAAA-MM-DD do relógio no dia em que os valores foram lidos do lugar real. */
  conferidoEm: string
  pc?: {
    /** Caminho absoluto do clone neste PC, com barras normais. */
    pasta: string
    repositorio?: string
    ramoPrincipal?: string
    comoRodar?: string[]
    comoTestar?: string[]
  }
  /** Lido e ignorado nesta edição, que só trabalha neste computador: fica no formato para uma prateleira antiga carregar. */
  vps?: {
    host: string
    pasta: string
    processos?: string[]
    portas?: { nome: string; porta: number; ambiente: 'producao' | 'teste' }[]
    enderecoTeste?: string
    enderecoProducao?: string
  }
  /** Nomes exatos de pacote cujas versões entram nos fatos vivos (ex.: "next"). */
  stack?: string[]
  /** Arquivos, relativos a pc.pasta (ou à cópia de trabalho do especialista, quando o território fica nela), de onde as versões são lidas (ex.: "package.json"). */
  arquivosDeVersao?: string[]
  /** Caminhos (relativos a pc.pasta, ou absolutos) que nenhum especialista do projeto escreve. */
  naoToque: string[]
  regras: Regra[]
  kitsSugeridos?: string[]
}

/** prateleira/tipos/<id>.json */
export type TipoTrabalho = {
  id: string
  nome: string
  metodo: Regra[]
  /** Ids de kit usados quando a ficha não diz os seus. */
  kitPadrao: string[]
  esforcoPadrao: Esforco
  /** Um exemplo de "pronto" bem escrito para este tipo, mostrado no cardápio. */
  prontoExemplo: string
}

/** prateleira/kits.json: { "kits": Kit[] } */
export type Kit = {
  id: string
  nome: string
  quandoUsar: string
  /** Nomes exatos de ferramenta, como o Claude Code os chama. O mod tira os que a sessão não tem. */
  ferramentas: string[]
  /** Ids de Aprovado pré-carregados com o kit. */
  skills?: string[]
  servidoresMcp?: string[]
  /** Tem ferramenta que escreve arquivo (Edit, Write, NotebookEdit). */
  escreve: boolean
  /** Tem Bash ou PowerShell. */
  shell: boolean
  notas?: Regra[]
  /**
   * O que este kit liga quando o especialista roda no Codex. Vale só para aquela execução:
   * nada é gravado na configuração do Codex do dono.
   */
  codex?: EquipamentoCodex
}

export type EquipamentoCodex = {
  /** Trocas de configuração, cada uma "chave=valor" como o `-c` do codex aceita (ex.: `web_search="live"`). */
  config?: string[]
  /** Recursos ligados com `--enable`. */
  habilitar?: string[]
  /** Recursos desligados com `--disable`. */
  desabilitar?: string[]
}

/** prateleira/aprovados.json: { "aprovados": Aprovado[] } */
export type Aprovado = {
  id: string
  tipo: 'skill'
  /** Nome pelo qual o Claude Code carrega a skill (ex.: "minha-skill", ou "meu-plugin:minha-skill"). */
  nome: string
  /**
   * Caminho do SKILL.md neste computador, ou "<marketplace>@<plugin>". Com caminho e versão "sha256:", o mod confere
   * a impressão digital ao carregar a prateleira, e a skill que mudou desde a aprovação fica fora até nova aprovação.
   */
  origem: string
  /** Versão declarada, ou "sha256:<hash>" do SKILL.md. */
  versao: string
  /** Caracteres do SKILL.md. */
  peso: number
  quandoUsar: string
  /** Lote em que a pessoa liberou (ex.: "pessoa-2026-11-17", que a ferramenta skills grava). */
  lote: string
}

/** prateleira/licoes.json: { "licoes": Licao[] } */
export type Licao = Regra & {
  id: string
  /** "todos", ou ids de tipo, de projeto e de kit em que a lição entra na ficha. */
  vale: string[]
  /** A lição só vale quando a pasta do especialista está no git (ramo, commit, PR); fora do git ela sai da ficha. */
  soComGit?: boolean
}

/**
 * prateleira/casa.json: regras que valem para todo especialista, em qualquer projeto. A casa.json da prateleira da
 * pessoa soma as listas dela às do plugin.
 */
export type Casa = {
  /**
   * Tipos de ajudante que não precisam de ficha. "*" no fim vale como prefixo (ex.: "meu-plugin:*"). Um ajudante que
   * vem no Claude Code (Explore, Plan) só entra pelo nome exato, nunca por prefixo.
   */
  listaLivre: string[]
  /**
   * Só na casa.json da pessoa: true troca a lista livre do plugin pela dela, em vez de somar (para quem não quer
   * nenhum ajudante do Claude Code sem ficha).
   */
  substituirListaLivre?: boolean
  /**
   * Caminhos que nenhum especialista escreve, nem com "ampliar". Três formas: absoluto;
   * começando por "~/" (pasta do usuário); ou "**​/<nome>" para um nome de arquivo em qualquer
   * pasta, com "*" valendo por qualquer trecho do nome (ex.: "**​/.env", "**​/.env.*").
   */
  naoToque: string[]
  /** Comandos de shell recusados a especialistas: expressão regular (sem distinguir maiúsculas) e o motivo. */
  comandosRecusados: { padrao: string; motivo: string }[]
}

export type Prateleira = {
  casa: Casa
  motores: Motor[]
  projetos: Projeto[]
  tipos: TipoTrabalho[]
  kits: Kit[]
  aprovados: Aprovado[]
  licoes: Licao[]
  /** Texto de prateleira/devolucao.md. */
  devolucao: string
}

// --------------------------------------------------------------------- ficha

export type Dossie = {
  /** O quê e o porquê. */
  objetivo: string
  contexto: string
  estadoAlvo: string
  /** Pastas ou arquivos em que o especialista escreve. Relativos à pasta do projeto, ou absolutos. */
  trabalheSoEm: string[]
  /** Caminhos de trabalheSoEm que ainda não existem e serão criados. */
  criar?: string[]
  naoToqueEm?: string[]
  restricoes?: string[]
  /** Como provar que terminou: comando com resultado esperado, ou o que se vê e onde. */
  pronto: { comando?: string; esperado: string; comoVer?: string }
  limitesDeAcao: string[]
  relatorio?: string
}

export type Ficha = {
  /** Minúsculas, dígitos e hífen, até 40. Vira o tipo "alrix-equipe:<nome>". */
  nome: string
  /** Uma linha: quando o chefe chama este especialista. */
  descricao: string
  /** Id de Projeto. */
  projeto: string
  /** Id de TipoTrabalho. */
  tipo: string
  /** Ids de Kit. Vazio ou ausente: kitPadrao do tipo. */
  kits?: string[]
  /** Ids de Aprovado além dos que os kits trazem. Só valem no motor claude. */
  skills?: string[]
  /** Id de ModeloDef. Ausente: o modelo marcado como padrão. O motor sai do modelo. */
  modelo?: string
  /** Obrigatório quando o modelo ou o esforço pede cartão. */
  motivoModelo?: string
  /**
   * Só para o Fable: as palavras do dono, copiadas da conversa desta sessão, que pedem o Fable. O mod confere
   * que elas estão numa mensagem que ele mesmo escreveu (decisão do dono de 12/11/2026).
   */
  pedidoDono?: string
  /** Ausente: esforcoPadrao do tipo. */
  esforco?: Esforco
  /** Ausente: pc. */
  destino?: Destino
  /** Trabalho grande: desenho aprovado e a fase que esta ficha cumpre. */
  desenho?: { caminho: string; fase: string }
  dossie: Dossie
}

// ------------------------------------------------------ ferramentas do chefe

export type PedidoCardapio = { projeto?: string; tipo?: string }

export type PedidoMontar = {
  time: Ficha[]
  /** "grande" exige ficha.desenho em toda ficha que escreve. */
  porte?: 'normal' | 'grande'
}

/** A ferramenta gravar_projeto: a ficha de um projeto, gravada na prateleira da pessoa depois da conferência. */
export type PedidoProjeto = {
  id: string
  nome: string
  resumo: string
  /** Pasta do projeto neste computador; ausente, a pasta da sessão. */
  pasta?: string
  repositorio?: string
  ramoPrincipal?: string
  comoRodar?: string[]
  comoTestar?: string[]
  stack?: string[]
  arquivosDeVersao?: string[]
  naoToque?: string[]
  regras?: Regra[]
  kitsSugeridos?: string[]
  /** true para trocar um projeto que a pessoa já gravou com este id (o anterior fica em <id>.json.anterior). */
  substituir?: boolean
}

/** A ferramenta skills: sem aprovar, lista as skills instaladas; com aprovar, a pessoa confirma no cartão. */
export type PedidoSkills = { aprovar?: { nome: string; quandoUsar?: string }[] }

export type PedidoAmpliar = { especialista: string; caminhos: string[]; motivo: string }
export type PedidoDispensar = { especialista: string }
/** Só para especialista do motor codex: começa o trabalho, ou manda uma mensagem a um que já rodou. */
export type PedidoAcionar = { especialista: string; mensagem?: string }

/** Uma falha da régua. */
export type Falha = { especialista: string; campo: string; motivo: string }

/** Peso em caracteres de cada camada do texto da ficha. */
export type Pesos = {
  dossie: number
  projeto: number
  tipo: number
  licoes: number
  kits: number
  /** A camada "Seu time": o chefe, os colegas e como falar com eles. */
  time: number
  devolucao: number
  fatos: number
  total: number
}

export type FatosVivos = {
  /** "terça, 10/11/2026" a partir do relógio. */
  hoje: string
  /** A cópia de trabalho (raiz do git) de onde ramo, commit e versões foram lidos, quando não é a pasta do projeto. */
  copia?: string
  ramo?: string
  commit?: string
  /** O git respondeu na pasta (true) ou não (false); ausente quando não se perguntou (VPS, projeto sem pasta no PC). */
  git?: boolean
  /** "next 16.1.0" e semelhantes. */
  versoes: string[]
}

// --------------------------------------------------------------------- codex

/** Um balde de limite, como scripts/codex-limite.mjs devolve. */
export type BaldeCodex = {
  id: string
  nome: string | null
  modelo: string | null
  /** Preenchido pelo servidor quando o limite foi atingido; null quando não. */
  limiteAtingido: string | null
  gastoBarrado: boolean | null
  janelaA: JanelaCodex | null
  janelaB: JanelaCodex | null
  temCredito: boolean | null
  plano: string | null
}
export type JanelaCodex = { usadoPct: number; minutos: number | null; voltaEm: number | null }

/** Saída de `node scripts/codex-limite.mjs` (uma linha JSON). */
export type LeituraCodex =
  | {
      ok: true
      /** Segundos Unix. */
      lidoEm: number
      /** true: pode usar. false: barrado. null: o servidor não soube dizer (trate como barrado). */
      usoComumLiberado: boolean | null
      geral: BaldeCodex
      baldes: BaldeCodex[]
      /** Modelos que o Codex instalado oferece a esta conta; null se o catálogo não pôde ser lido. */
      modelos: { id: string; nome: string; esforcos: string[] }[] | null
    }
  | { ok: false; motivo: string; detalhe?: string }

/** <pasta do trabalho>/pedido.json, lido por scripts/codex-rodar.mjs. Ao lado dele: ficha.md e, se houver, mensagem.md. */
export type PedidoCodex = {
  modelo: string
  esforco: Esforco
  /** Pasta do projeto: onde o Codex roda e, se escreve, onde pode escrever. */
  pasta: string
  escreve: boolean
  /** Outras pastas graváveis (só em execução nova). */
  pastasExtras?: string[]
  /** Id da sessão do Codex a retomar; ausente em execução nova. */
  retomar?: string
  /** Minutos até o vigia encerrar a execução. Ausente: 90. */
  limiteMin?: number
  codexHome?: string
  /** Soma do EquipamentoCodex dos kits da ficha, sem repetição. */
  config?: string[]
  habilitar?: string[]
  desabilitar?: string[]
  /** Só para teste: comando e argumentos que tomam o lugar do codex. */
  executavel?: string[]
}

/** <pasta do trabalho>/estado.json, gravado por scripts/codex-rodar.mjs. */
export type EstadoCodex = {
  fase: 'iniciando' | 'rodando' | 'terminou' | 'falhou'
  pid?: number
  vigia?: number
  /** ISO 8601 do relógio. */
  iniciadoEm?: string
  terminouEm?: string
  codigo?: number | null
  /** Id da sessão do Codex, para retomar. */
  sessao?: string
  /** A execução falhou por limite de uso ou falta de crédito. */
  limiteEstourou?: boolean
  /** Caminhos absolutos que mudaram durante a execução (um registro antigo os traz relativos à pasta); null fora de um repositório git. */
  alterados?: string[] | null
  /** Tokens que o Codex informou no fim do turno, quando informou. */
  uso?: Record<string, number>
  erro?: string
}
