// Contrato do $.state do alrix-equipe: o que a sessão guarda e que sobrevive a uma recarga do mod.
// Os formatos da prateleira, da ficha e dos roteiros do Codex estão em hooks/contrato.ts; aqui só o estado.

export type EquipeEsforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** Peso em caracteres de cada camada do texto da ficha (o mesmo formato de Pesos em hooks/contrato.ts). */
export type EquipePesos = {
  dossie: number
  projeto: number
  tipo: number
  licoes: number
  kits: number
  /** A camada "Seu time"; ausente em quem foi montado antes dela existir. */
  time?: number
  devolucao: number
  fatos: number
  total: number
}

/** Uma execução de um especialista do Codex, numa pasta de trabalho só dela. */
export type EquipeCodexExecucao = {
  /** 1 para a primeira, 2 para a primeira retomada, e assim por diante. */
  n: number
  /** Pasta do trabalho (pedido.json, ficha.md, estado.json, final.md). */
  pasta: string
  fase: 'iniciando' | 'rodando' | 'terminou' | 'falhou'
  iniciadoEm: number
  terminouEm?: number
  /** Id da sessão do Codex, para a próxima retomada. */
  sessao?: string
  /** Caminho de final.md, a última mensagem do Codex. */
  final?: string
  /** Arquivos que mudaram fora do território (só informação ao chefe). */
  alteradosFora?: string[]
  /** O git não pôde dizer o que mudou (pasta fora de um repositório). */
  semGit?: boolean
  erro?: string
  /** O chefe já recebeu o aviso do fim. */
  entregue: boolean
}

/**
 * O git status de uma pasta quando um especialista nativo do Codex começou a vez: a raiz do repositório e, por caminho
 * relativo a ela, "XY|hora de gravação". null quando o git não pôde dizer (pasta fora de um repositório).
 */
export type EquipeRetrato = { raiz: string; itens: Record<string, string> } | null

/** Um especialista do time desta sessão. */
export type EquipeEspecialista = {
  nome: string
  /** "alrix-equipe:<nome>" no motor claude e no Codex nativo (pelo astra); vazio no Codex por roteiro, que não registra tipo. */
  tipo: string
  motor: 'claude' | 'codex'
  destino: 'pc' | 'vps'
  descricao: string
  projeto: string
  /** Pasta do projeto no destino (base dos caminhos relativos da ficha). */
  pastaProjeto: string
  modelo: string
  esforco: EquipeEsforco
  kits: string[]
  /** Ferramentas registradas no tipo (as dos kits que a sessão tem). */
  ferramentas: string[]
  /** Nomes de skill pré-carregados. */
  skills: string[]
  servidoresMcp: string[]
  /** Algum kit escreve arquivo. */
  escreve: boolean
  /** Algum kit tem a ferramenta Agent. */
  abreAjudante: boolean
  /** O texto da ficha, para registrar o tipo de novo depois de uma recarga. */
  texto: string
  pesos: EquipePesos
  /** Caminhos absolutos e normalizados em que pode escrever. */
  territorio: string[]
  /** "Não toque em" da ficha e do projeto, absolutos e normalizados. */
  naoToque: string[]
  estado: 'pronto' | 'trabalhando' | 'terminou' | 'dispensado'
  criadoEm: number
  /** Cada ajudante nascido deste tipo. */
  agentIds: string[]
  /** Os que estão rodando agora. */
  emExecucao: string[]
  barradas: number
  ampliacoes: { caminhos: string[]; motivo: string; em: number }[]
  codex?: { execucoes: EquipeCodexExecucao[] }
  /** O especialista do Codex nasceu como agente nativo do Claude Code (pelo plugin astra): chama-se com Agent, não com acionar. */
  nativo?: true
  /** No Codex nativo, por agentId que está rodando: o git status da pasta do projeto quando a vez começou. */
  retratos?: Record<string, EquipeRetrato>
  /** No Codex nativo, o que o mod achou no fim da última vez. */
  nativoFim?: { em: number; alteradosFora: string[]; semGit: boolean }
  /** Id da missão, quando o destino é a VPS. */
  missao?: string
  // Os campos abaixo servem à tela. São todos opcionais: um especialista guardado antes deles não os tem.
  /** O nome do modelo como o dono lê ("Fable 5.2"). */
  modeloNome?: string
  /** O nome do projeto como o dono lê. */
  projetoNome?: string
  /** O começo do objetivo do dossiê, até 200 caracteres: em que ele trabalha. */
  objetivo?: string
  /** Quantas vezes começou a trabalhar: nascimentos, retomadas e execuções do Codex. */
  rodadas?: number
  /** Hora em que a rodada atual (ou a última) começou. */
  iniciouEm?: number
  /** Hora em que a última rodada terminou; ausente enquanto alguém roda. */
  terminouEm?: number
  /** A última escrita ou o último comando recusado. */
  ultimaRecusa?: { ferramenta: string; alvo: string; motivo: string; em: number }
  /** Contexto ao nascer: tokens de entrada da primeira resposta do modelo. */
  tokensAoNascer?: number
  /** Comandos de espera (laço que dorme, laço sem fim, sleep longo) que o mod recusou a ele. */
  esperasRecusadas?: number
  /** Os ids dos ajudantes que ele abriu (estão também em agentIds): uma mensagem a ele nunca retoma um destes. */
  ajudantes?: string[]
  /** O modelo em que ele rodou de fato, como a API respondeu na primeira resposta (usage.model do turn.step). */
  modeloReal?: string
}

/** Uma escrita ou um comando recusado a um especialista. */
export type EquipeBarrada = {
  especialista: string
  ferramenta: string
  /** O caminho real (escrita) ou o começo do comando (shell). */
  alvo: string
  motivo: string
  em: number
  /** Ainda espera o chefe decidir (ampliar ou dispensar). */
  pendente: boolean
}

/** No modo aviso: o que o modo barrar teria recusado ou trocado. */
export type EquipeAviso = { em: number; caso: string; visto: boolean }

/** Contexto ao nascer: tokens de entrada da primeira resposta do modelo. */
export type EquipeMedida = { especialista: string; agentId: string; tokens: number; modelo: string; em: number }

/** Leitura do limite do Codex (formato LeituraCodex de hooks/contrato.ts) e se ele está fora. */
export type EquipeCodex = {
  leitura: { ok: boolean; [campo: string]: unknown } | null
  lidoEm: number
  /** "limite" depois de uma execução que estourou o limite; null quando não há motivo para dizer que está fora. */
  fora: string | null
}

export type EquipeMemoria = { gb: number | null; lidoEm: number }

/** O relógio da tela: quando começou e quando parou a rodada mais recente de cada especialista. */
export type EquipePulso = {
  /** O relógio na última vez em que a tela precisou mudar. */
  agora: number
  /** Por nome: o começo da rodada em curso, ou da última. */
  inicio: Record<string, number>
  /** Por nome: o fim da última rodada; sem a chave enquanto ela roda. */
  fim: Record<string, number>
}

/** Uma lição proposta, esperando o dono na fila. */
export type EquipeLicaoProposta = { regra: string; motivo: string; escopo?: string; em: string; sessao: string; por: string }

declare module 'claude-code' {
  interface PluginState {
    'alrix-equipe': {
      time: Shaped<EquipeEspecialista[]>
      /** "sessao" depois de "Liberar nesta sessão". */
      liberacao: 'nenhuma' | 'sessao'
      /** Tipos que `montar` registrou neste turno e que esperam o aviso que abre o turno seguinte. */
      acordar: string[]
      barradas: Shaped<EquipeBarrada[]>
      avisos: Shaped<EquipeAviso[]>
      medidas: Shaped<EquipeMedida[]>
      codex: Shaped<EquipeCodex>
      memoria: Shaped<EquipeMemoria>
      fila: Shaped<EquipeLicaoProposta[]>
      pulso: Shaped<EquipePulso>
      /** Quem desenha o time: "barra" quando uma barra de estado que leia o time está de pé; senão "campo" (sob o campo de texto). */
      vitrine: 'barra' | 'campo'
      /** As últimas mensagens que o dono escreveu (origem composer ou bridge), para conferir o pedido do Fable. */
      pedidosDono: string[]
      /** O id da sessão dona do time que está em `time` (um /resume ou /clear no mesmo processo troca a sessão). */
      sessaoDoTime: string
      /** Especialistas de outra sessão deste processo que ainda rodavam quando a sessão trocou: seguem vigiados. */
      vigiados: Shaped<EquipeEspecialista[]>
      /** Os ids de todo ajudante rodando agora nesta sessão (do time, do chefe, de workflow), para o teto. */
      rodandoIds: string[]
    }
  }
}
