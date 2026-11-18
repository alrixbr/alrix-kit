# astra: o Codex como agente do Claude Code

O astra põe o Codex da OpenAI para trabalhar dentro do Claude Code. Com ele instalado, o Claude Code ganha agentes que respondem com os modelos do Codex (GPT-6.2 Astra e GPT-6.2 Sol), usando a sua conta do ChatGPT. O Claude que conversa com você abre esses agentes como abre qualquer outro, e o Codex trabalha na sua pasta com as ferramentas dele, falando com o resto do time pelo Claude Code.

## O que você precisa

- **Claude Code** instalado (o astra foi testado na versão 2.1.327).
- **Node.js 22.18 ou mais novo**. Baixe a versão LTS em https://nodejs.org. Para conferir, rode `node --version` num terminal.
- **Codex instalado e com login.** No terminal (no Windows, o PowerShell):

  ```
  npm.cmd install -g @openai/codex
  codex.cmd login
  ```

  O `.cmd` no fim é de propósito: num Windows recém-instalado, o PowerShell bloqueia os atalhos `npm` e `codex` sem ele, com o erro "a execução de scripts foi desabilitada neste sistema". No Linux e no macOS, escreva sem o `.cmd`. O `codex login` abre o navegador para você entrar com a sua conta do ChatGPT. O astra usa o limite de uso dessa conta, como o próprio Codex usa. Se o Codex já está instalado de outro jeito e o comando `codex` funciona no terminal, não precisa instalar de novo.

Funciona no Windows 11 (sem WSL), no Linux e no macOS.

## Instalar

No Claude Code, digite:

```
/plugin install astra --marketplace alrixbr/alrix-kit
```

Responda `y` para adicionar o marketplace e escolha onde instalar (para você, em todas as pastas, é o mais comum). Pelo terminal, o mesmo comando é:

```
claude plugin install astra --marketplace alrixbr/alrix-kit
```

O repositório do kit é aberto: não precisa de conta do GitHub nem de convite. O seu computador só precisa ter o Git instalado (`winget install Git.Git` no Windows), porque é por ele que o Claude Code baixa os plugins.

## Primeiro uso

Abra uma sessão nova do Claude Code e peça, com as suas palavras, que ele use um agente do astra. Por exemplo:

> Peça ao astra:sol para corrigir o teste que está falhando em `src/calculo.test.ts`.

Os agentes do astra:

| Agente | Modelo | Para quê |
| --- | --- | --- |
| `astra:sol` | GPT-6.2 Sol, esforço high | O dia a dia: tarefas de código de rotina ou em volume. |
| `astra:xhigh` | GPT-6.2 Astra, esforço xhigh | Tarefa de código grande, segunda implementação, diagnóstico independente do Claude. |
| `astra:max` | GPT-6.2 Astra, esforço max | Só o problema difícil de verdade. É o que mais gasta do limite do Codex. |
| `astra:codereviewer` | GPT-6.2 Astra, esforço xhigh | Revisão de código, só leitura: aponta o que bloquearia o merge. |

O agente trabalha na pasta da sessão. Para ele trabalhar em outra, comece o pedido com uma linha assim:

```
cwd: C:\projetos\site
```

No Linux e no macOS, o caminho é do tipo `cwd: /home/voce/projetos/site`.

O comando `/astra` mostra os agentes do astra que estão rodando na sessão, e `/astra ver 1` põe a conversa do primeiro deles na tela (`/astra voltar` volta à conversa principal).

A conversa principal também pode ser do Codex: aberta com um agente do astra (`claude --agent astra:sol`), cada resposta dela vem do Codex, com o modelo daquele agente.

## Opções

No Claude Code, abra `/config` e procure as linhas do astra:

- **Acesso total para o Codex** (desligada por padrão). Desligada, o Codex dos agentes do astra só grava arquivos na pasta de trabalho; o revisor só lê. Ligada, o Codex dos agentes que constroem roda sem sandbox e pode gravar em qualquer lugar do computador. Ligue só se você sabe que precisa.
- **Caminho do Codex** (vazio por padrão). Deixe vazio para o astra achar o Codex sozinho. Preencha só se o Codex está instalado fora do PATH, com o caminho completo do programa (por exemplo, `C:\ferramentas\codex.exe`).

Também dá para ver e mudar as opções pelo terminal com `claude plugin configure astra`.

## Quando algo falta

O astra não atrapalha a abertura da sessão: sem Node, sem Codex ou sem login, o Claude Code abre normalmente, e só o pedido a um agente do astra volta com uma frase que diz o que falta e como resolver. As frases são estas:

- Sem Node.js, ou com um Node velho: instale a versão LTS em https://nodejs.org e abra o Claude Code de novo.
- Sem Codex: instale com `npm install -g @openai/codex`, faça login com `codex login` e peça de novo (ou informe o caminho na opção do Codex).
- Sem login: rode `codex login` num terminal e peça de novo.

No PowerShell do Windows, escreva esses dois comandos com `.cmd` no fim (`npm.cmd`, `codex.cmd`), como em "O que você precisa".

## Limites

- Cada pedido a um agente do astra gasta do limite de uso da sua conta do ChatGPT no Codex, e não do Claude.
- O Codex usa as ferramentas dele para o shell e para ler e editar arquivos. Do Claude Code ele recebe hoje só o Agent, o SendMessage, o ListAgents, o Skill, o AskUserQuestion e o WebFetch (o que a sessão tiver deles). As ferramentas de servidores MCP que você tem no Claude Code não chegam ao Codex.
- Quando um agente do astra trabalha como subagente e o Claude Code exige que o relatório volte pela ferramenta de entrega (o SubagentHandback, que aparece no modo de permissão auto), quem faz a entrega é o astra: a resposta final do Codex vai inteira para quem chamou. O Codex não recebe essa ferramenta. Se o Claude Code cobrar a entrega depois que a resposta já saiu, o astra entrega a mesma resposta de novo, sem pedir outra ao Codex. Na conversa principal e nos outros modos, a resposta sai em texto, como sempre.
- O Claude Code não conta a um plugin quais ferramentas um subagente recebeu. O astra reconhece a exigência da entrega pelo aviso que o próprio Claude Code escreve na conversa do subagente. Se uma versão nova do Claude Code mudar esse aviso, a entrega pode voltar a falhar, e quem chamou recebe a mensagem de que o agente terminou sem relatório.
- Quando uma regra automática do Claude Code (um hook) devolve o trabalho a um agente do astra depois da resposta, por exemplo para pedir que ele confira algo antes de terminar, a mensagem dessa regra abre uma nova rodada do Codex na mesma conversa dele.
- No Windows, o astra fala com o Codex por uma porta local (127.0.0.1) que só aceita pedidos com um segredo sorteado a cada sessão. No Linux e no macOS, por um arquivo de socket que só o seu usuário abre.
- O astra guarda o vínculo entre cada agente e a conversa dele no Codex em `%LOCALAPPDATA%\alrix-astra\state` (Windows), `~/Library/Application Support/alrix-astra` (macOS) ou `~/.local/state/alrix-astra` (Linux). O astra não manda nada para outro lugar. As conversas ficam também no histórico do próprio Codex, como as de qualquer uso dele.
- O astra foi conferido contra o Codex 0.169.0. Com outra versão ele tenta do mesmo jeito, mas o que mudou no Codex desde então não foi conferido. Se algo parar de funcionar depois de atualizar o Codex, essa é a primeira coisa a olhar.

## Desligar

Para desligar sem desinstalar, no terminal:

```
claude plugin disable astra
```

Para ligar de novo, `claude plugin enable astra`. Também dá para fazer pelo menu `/plugin` dentro do Claude Code. Para tirar de vez, `claude plugin uninstall astra`.

## Para quem escreve outro plugin

O astra responde também a tipos de agente que outro plugin define. O contrato é este, e os testes em `tests/contract.test.ts` cobrem cada parte:

1. **Qualquer passo `gpt-*` vai ao Codex.** Todo passo cujo modelo começa com `gpt-` e um número (`gpt-6.2-astra`, `gpt-6.2-sol`), de qualquer plugin ou da conversa principal, é respondido pelo Codex. O modelo e o esforço que chegam ao Codex são os do passo.
2. **O prompt do seu tipo chega ao Codex.** Registre o tipo com `$.agent.register({ name, description, prompt, model: 'gpt-6.2-astra', effort, tools })`. O astra lê o registro no evento `agent.register` e, no passo desse tipo, manda ao Codex como instrução primeiro o papel da ponte (`roles/bridge.md`, que explica as ferramentas do Claude Code) e depois o seu `prompt`, como você o escreveu. Um tipo que vem de um arquivo `agents/*.md` do seu plugin não passa por esse evento: ele roda só com o papel da ponte, sem o texto do arquivo, porque o motor não mostra o prompt de um tipo a outro plugin no passo.
3. **O sandbox sai das ferramentas do tipo.** Se o `tools` do tipo não tem `Edit`, `Write`, `MultiEdit` nem `NotebookEdit` (ou os tira em `disallowedTools`), o Codex roda em `read-only`. Se tem alguma delas, ou se o tipo não diz as ferramentas, em `workspace-write` na pasta de trabalho. Um tipo de outro plugin nunca recebe acesso total, nem com a opção ligada. Isso vale para o tipo registrado com `$.agent.register`: o tipo que vem de um arquivo `agents/*.md` não mostra as ferramentas dele ao astra e roda em `workspace-write`, mesmo que o arquivo liste só ferramentas de leitura. Para um revisor que não pode gravar, registre o tipo. O catálogo de ferramentas do Claude Code que o Codex vê também fica restrito ao `tools` e ao `disallowedTools` do tipo.
4. **A pasta de trabalho vem da linha `cwd:`.** Se a primeira linha do primeiro pedido do agente é `cwd: <caminho absoluto>` (`/caminho`, `C:\caminho` ou `C:/caminho`), o Codex trabalha nessa pasta em todos os passos do agente, e a linha sai do pedido. Sem ela, vale a pasta da sessão. Um caminho que não existe faz o passo recusar, sem abrir o Codex.

5. **O comando `astra` diz que o astra está ligado.** Ao abrir a sessão, o astra registra o comando `/astra`. Para saber se ele está ligado, procure em `$.command.list()` um comando com `source: 'plugin'`, `name: 'astra'` e o `plugin` igual a `astra` ou começando por `astra@`. Com o astra desligado ou desinstalado, o comando não aparece.
6. **A entrega do relatório vale para o seu tipo.** Quando o Claude Code exige que o subagente entregue o relatório pelo `SubagentHandback`, o astra faz a entrega também para os tipos de outros plugins: a resposta final do Codex vai inteira para quem chamou. Um gancho seu de `tool.call` sobre o `SubagentHandback` vê essa chamada como a de qualquer subagente.
7. **A falha do Codex vem numa linha que começa por `[astra]`.** Quando o turno do Codex não termina bem, a resposta do passo traz `[astra] O turno do Codex falhou: <a mensagem do Codex>`, `[astra] O turno do Codex foi interrompido.` ou `[astra] O Codex terminou o turno sem resposta em texto.` O limite de uso estourado chega assim, com a mensagem do próprio Codex.

Não é preciso importar nada do astra: basta registrar o tipo com um modelo `gpt-*`.

## Para quem mexe no astra

- Testes do mod: `claude plugin test plugins/astra`.
- Testes da ponte, com um App Server de mentira (sem gastar nada do Codex): `node --test --experimental-strip-types --no-warnings --test-concurrency=1 tests/bridge-channel.node.mts tests/bridge-native.node.mts tests/bridge-f4.node.mts tests/bridge-f5.node.mts tests/bridge-f6.node.mts`, rodado de dentro da pasta do plugin.
- `schemas/claude-tools.json` traz o schema das ferramentas do Claude Code que o Codex recebe. Para gerar de novo depois de atualizar o Claude Code, rode num terminal, de uma pasta que o Claude Code já confia: `node --no-warnings scripts/sync-tools.mts`. O roteiro abre um Claude Code interativo apontado para um servidor local que só lê a lista de ferramentas do pedido e responde erro: nada chega à API e nenhuma cota é gasta, mas a sessão aparece na tela até o roteiro fechá-la. Se o `claude` não está no PATH como programa (no Windows, o `claude.cmd` do npm), informe o caminho do `claude.exe` na variável `ASTRA_CLAUDE`.
