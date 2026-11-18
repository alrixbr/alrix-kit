# alrix-equipe

## O que este mod faz

Quando o agente principal da sua sessão do Claude Code (aqui chamado de "chefe") precisa de ajuda, ele costuma abrir ajudantes genéricos, que não conhecem o seu projeto e podem escrever em qualquer lugar. Com este mod, o chefe monta cada ajudante sob medida para a tarefa. Cada um desses ajudantes se chama "especialista" e vale até o fim da sessão.

Para montar um especialista, o chefe escreve uma "ficha": o projeto, o tipo de trabalho, as ferramentas, as skills, o objetivo, onde ele pode escrever e como provar que terminou. O mod confere a ficha antes de criar qualquer coisa. Depois mostra um cartão para você com o time, o modelo de cada um e a pasta onde cada um escreve, e só cria os especialistas se você liberar.

Enquanto eles trabalham, o mod faz valer estes limites:

- nenhum especialista escreve fora da pasta combinada na ficha;
- nenhum especialista escreve nos arquivos de configuração do Claude Code nem nos seus arquivos de segredo (`.env`, credenciais);
- nenhum especialista abre outros ajudantes sem ter recebido esse poder na ficha;
- nenhum especialista abre o Codex ou outro Claude pelo terminal, o que gastaria a sua cota sem você ver;
- nenhum especialista fica preso num laço de espera no terminal;
- o time tem no máximo 10 especialistas, e nenhum nasce com menos de 2 GB de memória livre no computador.

O modelo padrão é o Sonnet. O Opus também pode ser escolhido. O Fable só entra quando você mesmo pede na conversa, e o Haiku não entra.

## Como instalar

No terminal (PowerShell no Windows, ou o terminal do Linux e do macOS), rode:

```
claude plugin install alrix-equipe --marketplace alrixbr/alrix-kit
```

O comando acrescenta a loja `alrixbr/alrix-kit` e instala o mod num passo só. Se o Claude Code perguntar o escopo, escolha o do usuário; se mostrar as opções do mod, pode deixar como estão. Quem instala o kit inteiro pela linha do README principal não precisa deste comando: o instalador já instala este mod.

A loja fica num repositório aberto do GitHub: não precisa de conta nem de convite. O seu computador só precisa ter o Git instalado (`winget install Git.Git` no Windows), porque é por ele que o Claude Code baixa os plugins.

No aplicativo do Claude Code para desktop, clique no + ao lado da caixa de texto, depois em Plugins, em "Add marketplace" com `alrixbr/alrix-kit` e em "Add plugin".

O mod foi testado no Claude Code 2.1.327, no Windows 11.

## Primeiro uso, em três passos

1. **Abra o Claude Code na pasta do seu projeto** e peça uma tarefa normalmente, por exemplo: "monte um especialista para revisar o código da pasta src e me dizer o que está frágil".
2. **O chefe lê o cardápio do mod e escreve a ficha.** Sem nenhum arquivo criado por você, ele pode usar o projeto `esta-pasta`, que é a pasta onde você abriu a sessão.
3. **Você vê o cartão e decide.** O cartão mostra cada especialista, o modelo, o esforço e onde ele escreve. Escolha "Liberar este time", "Liberar nesta sessão" (os próximos times de Sonnet e Opus entram sem cartão) ou "Não".

Para acompanhar o time, digite `/equipe`: o painel mostra o que cada especialista faz, onde pode escrever e as escritas que o mod recusou.

## Como guardar a ficha de um projeto

O projeto `esta-pasta` serve para começar, mas não guarda nada: a cada sessão, o chefe precisa explicar de novo como testar e o que não tocar. Para o projeto ficar guardado, peça ao chefe:

> Grave a ficha deste projeto com o gravar_projeto: como testar é `npm test`, não toque em `.env` e em `dados/`, e a regra é abrir PR em vez de mexer no ramo principal, porque eu reviso tudo antes.

O chefe usa a ferramenta `gravar_projeto` do mod. O mod confere a ficha antes de gravar: o nome do projeto, a pasta (que precisa existir no seu computador) e o motivo de cada regra. Se faltar alguma coisa, nada é gravado e o chefe recebe a lista do que corrigir. Se já existir um projeto com o mesmo nome, ele só é trocado quando o chefe pede isso, e a ficha anterior fica guardada ao lado, com o final `.anterior`.

Depois disso, o projeto aparece no cardápio, e cada especialista dele já nasce sabendo a pasta, como testar, o que não tocar e as regras, com os motivos.

## Como aprovar uma skill para os especialistas

Os especialistas só usam as skills que você aprovou. Isso vale para as skills que você já tem instaladas: as suas, na pasta `skills` da configuração do Claude Code, e as que vêm nos plugins que você instalou.

1. Peça ao chefe: "liste as skills que eu tenho instaladas". Ele usa a ferramenta `skills` do mod, que mostra cada skill e diz se ela já está aprovada.
2. Peça: "aprove a skill tal para os especialistas". O mod mostra um cartão com as skills pedidas e para que cada uma serve.
3. Só quando você escolhe "Aprovar" a skill entra na sua prateleira, junto com a impressão digital do arquivo dela.

Se o arquivo da skill mudar depois da aprovação (por exemplo, quando o plugin dela é atualizado), ela sai dos especialistas e o cardápio avisa. Para ela voltar, aprove de novo. Nem o chefe nem um especialista conseguem escrever no arquivo das skills aprovadas: ele só muda pelo cartão.

## Onde ficam os seus arquivos

Tudo o que é seu fica fora da pasta do plugin, para sobreviver às atualizações:

- **A sua prateleira:** `alrix-equipe/prateleira`, dentro da pasta de configuração do Claude Code. No Windows, normalmente é `C:\Users\<você>\.claude\alrix-equipe\prateleira`. Se você usa a variável `CLAUDE_CONFIG_DIR`, a pasta fica dentro dela.
- **Os relatórios e o diagnóstico:** `alrix-equipe/sessoes` e `alrix-equipe/avisos`, na mesma pasta de configuração.

A sua prateleira soma à que vem no plugin. Nela podem ficar:

- `projetos/<nome>.json`: as fichas dos seus projetos (o `gravar_projeto` grava aqui);
- `aprovados.json`: as skills que você aprovou (a ferramenta `skills` grava aqui);
- `licoes.json`: regras que valem para os seus especialistas, cada uma com o motivo;
- `kits.json` e `tipos/<nome>.json`: conjuntos de ferramentas e tipos de trabalho seus;
- `casa.json`: a sua lista livre de ajudantes, os caminhos que nenhum especialista escreve e os comandos que nenhum deles roda.

Quando um item da sua prateleira tem o mesmo nome de um que vem no plugin, vale o seu. Os seus arquivos passam pela mesma conferência que os do plugin. Se um deles tiver um problema, o cardápio mostra o arquivo e o que está errado, e nenhum time é montado até você corrigir.

Para conferir as duas prateleiras de uma vez, com o Node 22.18 ou mais novo, rode `node scripts/conferir-prateleira.mjs` dentro da pasta do plugin.

## Os três modos

- **`aviso` (o padrão de quem instala):** o mod confere as fichas, mostra o cartão e faz valer a pasta de cada especialista. Os ajudantes genéricos que o chefe abrir sem ficha continuam funcionando, e o mod só anota o que o modo `barrar` teria recusado. É o modo para conhecer o mod.
- **`barrar`:** além disso, o mod recusa todo ajudante sem ficha que não esteja na lista livre, e diz ao chefe o que fazer no lugar. A lista livre que vem no plugin traz os ajudantes que só leem e que vêm no Claude Code (`Explore`, `Plan`, `claude-code-guide` e `web-fetch`) e o `pesquisador` do plugin alrix-base, do mesmo kit. Os ajudantes `Explore` e `Plan` não editam arquivos, mas podem rodar comandos no terminal.
- **`desligado`:** o mod não muda nada.

Para trocar de modo, use o menu `/plugin` dentro do Claude Code, ou rode no PowerShell:

```
'{"modo":"barrar"}' | claude plugin configure alrix-equipe@alrix --values-stdin
```

No Linux e no macOS, o mesmo comando começa com `echo`: `echo '{"modo":"barrar"}' | claude plugin configure alrix-equipe@alrix --values-stdin`. Para ver os valores de agora, rode `claude plugin configure alrix-equipe@alrix`. A troca vale a partir da próxima sessão do Claude Code.

As outras opções são o teto do time (10), o piso de memória (2 GB), o tamanho máximo da ficha, o que fazer com os ajudantes abertos pelos comandos que você digita, como `/review`, no modo `barrar`, e o jeito do especialista do Codex (veja abaixo).

## Como desligar

- **Por um tempo:** ponha o modo em `desligado`, ou rode `claude plugin disable alrix-equipe@alrix` (e `claude plugin enable alrix-equipe@alrix` para voltar).
- **De vez:** rode `claude plugin uninstall alrix-equipe@alrix`. A sua prateleira e os relatórios continuam na pasta de configuração do Claude Code; apague a pasta `alrix-equipe` de lá se não quiser mais nada.

## Especialistas do Codex (opcional)

Se você tem o Codex instalado e com login feito, o cardápio oferece também os modelos do Codex, como o GPT-6.2 Astra e o GPT-6.2 Sol. Todo especialista do Codex pede o cartão, porque gasta a cota do Codex. Quando o limite de uso do Codex acaba, os modelos dele saem do cardápio até o limite voltar. Sem o Codex, nada muda.

O especialista do Codex trabalha de um destes dois jeitos, e o cardápio diz qual vale na sua sessão:

- **Com o plugin astra ligado (o melhor jeito):** o especialista do Codex vira um agente do Claude Code, como os outros. O chefe o chama do mesmo jeito que chama um especialista do Claude, com a mesma ficha, o mesmo cartão e os mesmos limites. O Codex trabalha na pasta do projeto e, quando termina a vez, o mod confere o que ele gravou e avisa o chefe de cada arquivo que mudou fora da pasta combinada. O esforço vai de baixo a máximo.
- **Sem o astra:** o especialista do Codex roda por um roteiro à parte. O chefe o põe para trabalhar com a ferramenta `acionar`, e o mod avisa quando ele termina. Esse jeito aceita também o esforço `ultra`.

Para usar o primeiro jeito, instale o plugin astra, que vem no mesmo kit, e abra o Claude Code de novo. O instalador do kit já instala o astra quando encontra o Codex no computador; se você instalou o Codex depois, rode `claude plugin install astra@alrix`. O astra precisa do Codex com login feito e do Node.js 22.18 ou mais novo; o README dele explica o resto. Se você preferir o roteiro mesmo com o astra ligado, ponha a opção do especialista do Codex em `roteiro`:

```
'{"codexNativo":"roteiro"}' | claude plugin configure alrix-equipe@alrix --values-stdin
```

No Linux e no macOS, o mesmo comando começa com `echo`. Para voltar ao padrão, use `auto` no lugar de `roteiro`.

## O que há na prateleira do plugin

- `casa.json`: a lista livre de ajudantes, os caminhos que nenhum especialista escreve (arquivos `.env`, credenciais e as configurações do Claude Code e do Codex) e os comandos recusados (push forçado e abrir o Codex ou outro Claude pelo terminal).
- `kits.json`: os conjuntos de ferramentas. `leitura` só lê; `leitura-terminal` lê e roda comandos; `codigo` lê, escreve e roda comandos; `texto` lê e escreve sem terminal; `pesquisa-web` busca na web; `ajudantes` deixa o especialista abrir ajudantes.
- `tipos/`: os tipos de trabalho (código, conteúdo, escrita de instruções, pesquisa com fontes, revisão a frio e teste de tela), cada um com o método e o motivo de cada passo.
- `licoes.json`: as regras que todo especialista recebe, cada uma com o motivo.
- `motores.json`: os modelos que o cardápio oferece.
- `devolucao.md`: o molde da resposta que cada especialista devolve ao chefe.
