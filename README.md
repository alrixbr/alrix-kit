# ALRIX Kit

Plugins e ajustes para o Claude Code, instalados com uma linha.

```powershell
irm https://raw.githubusercontent.com/alrixbr/alrix-kit/main/instalar.ps1 | iex
```

Cole essa linha no PowerShell do Windows. Ela confere o que falta no computador, diz como instalar e, com tudo no lugar, instala o kit. Depois, abra uma sessão nova do Claude Code.

## O que vem no kit

| Parte | O que faz |
| --- | --- |
| **alrix-equipe** | O agente principal monta especialistas sob medida para cada tarefa. Cada um nasce com uma ficha (o projeto, as ferramentas, as skills que você aprovou, a pasta onde pode escrever e como provar que terminou), e você libera o time num cartão antes de ele começar. |
| **astra** | Os modelos do Codex (GPT-6.2 Astra e GPT-6.2 Sol) como agentes dentro do Claude Code, com a sua conta do ChatGPT. Com ele, o alrix-equipe monta também especialistas do Codex. Só é instalado se o Codex já estiver no computador e o Node.js for o 22.18 ou mais novo. |
| **alrix-prompt** | Modos para as suas mensagens: organizar a escrita ou reestruturar o pedido antes de enviar. |
| **alrix-base** | O relógio do computador junto de cada pedido, os seus pedidos de volta depois que a conversa compacta e o ajudante `pesquisador`. |
| **Barra de status** | O modelo, a pasta e o ramo do git, o uso do contexto, o cache, o custo, os limites do plano e o time da equipe. |
| **Contexto de 400 mil** | A conversa compacta sozinha ao chegar em 400 mil tokens. |

Cada plugin tem o seu próprio README, em `plugins/<nome>/README.md`, com o que ele faz e como desligar.

## O que você precisa

- **Windows 10 ou 11**, com o PowerShell que já vem nele.
- **Claude Code** atualizado. Para instalar: `irm https://claude.ai/install.ps1 | iex`. Para atualizar: `claude update`. O kit foi testado na versão 2.1.327 e não instala em versões anteriores à 2.1.275.
- **Node.js**. Para instalar: `winget install OpenJS.NodeJS.LTS`. O astra precisa do Node 22.18 ou mais novo; o resto funciona a partir do 18.
- **Git**. Para instalar: `winget install Git.Git`. O Claude Code usa o Git para baixar os plugins.
- **Codex** (opcional, só para o astra): `npm.cmd install -g @openai/codex` e depois `codex.cmd login`. O `.cmd` no fim é de propósito: num Windows recém-instalado, o PowerShell bloqueia os atalhos `npm` e `codex` sem ele.

Depois de instalar um desses programas, feche e abra o PowerShell para o Windows enxergar o programa novo. Se faltar algum, a linha de instalação avisa qual e mostra o comando.

## Ver antes o que muda

Esta linha só mostra o que seria feito. Nada é gravado.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/alrixbr/alrix-kit/main/instalar.ps1))) --simular
```

## O que o instalador mexe, e só isso

1. **Plugins**: instala pelo comando do próprio Claude Code (`claude plugin install`), no seu perfil de usuário.
2. **Barra de status**: copia os roteiros para `alrix-kit/barra`, dentro da sua pasta de configuração do Claude Code (`~/.claude`, ou a pasta da variável `CLAUDE_CONFIG_DIR`).
3. **`settings.json`**: antes de mexer, guarda uma cópia com data e hora em `alrix-kit/copias`. Depois junta só estas chaves:
   - `statusLine`: a barra de status;
   - `subagentStatusLine`: a linha de cada ajudante no painel de agentes;
   - `autoCompactWindow`: a compactação em 400 mil tokens (um valor geral e um por modelo).

Todo o resto do seu `settings.json` fica como está. Se você já tem uma barra de status própria, ela fica: o kit só a troca se você pedir com `--trocar-barra`. Se você já guardou outra janela de compactação, ela também fica (use `--trocar-janela` para trocar). Rodar duas vezes dá o mesmo resultado.

## O que a barra mostra

```
ΛLRIX  │ Opus 5.5 xhigh │ meu-projeto main ±3 ↑1 │ ━━━━━━━━━━ 184k/400k │ cache 92% · 48 min │ US$ 3,46 │ +120 −8
Limite │ 5 h ━━━━━━━━ 23% até 01:40 │ semana ━━━━━━━━ 61% até ter 05:00
Equipe │ ● revisor  Sonnet 5.5 · alto  há 17 min │ modo aviso
```

- **Primeira linha**: o modelo e o esforço; a pasta e o ramo do git (`±` arquivos mexidos, `↑`/`↓` commits à frente ou atrás); a barra do contexto até a compactação automática (âmbar a partir de 60 %, vermelha a partir de 85 %); a taxa de cache e quanto falta para ele esfriar ("frio" quer dizer que o próximo pedido reprocessa a conversa inteira); o custo e as linhas mudadas. Quando falta largura, saem primeiro os itens do fim.
- **Segunda linha**: os limites do seu plano nas últimas 5 horas e na semana. Só aparece para quem tem plano com limite.
- **Terceira linha em diante**: o time do alrix-equipe, quando há um na sessão.
- **Painel de agentes**: uma linha por ajudante, com o ritmo de trabalho, os tokens, o tempo e o modelo.

As cores foram escolhidas por contraste e servem para quem enxerga mal algumas cores. Para uma barra sem cor, defina a variável `NO_COLOR`.

## Opções extras (só entram se você pedir)

Use a mesma forma da linha de "Ver antes o que muda" e troque `--simular` pela opção. Por exemplo, para instalar com o tema escuro:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/alrixbr/alrix-kit/main/instalar.ps1))) --tema escuro
```

| Opção | O que faz |
| --- | --- |
| `--verbos` | troca as palavras que aparecem enquanto o Claude trabalha ("Lendo o contexto", "Conferindo premissas"…) |
| `--dicas` | acrescenta dicas curtas à rotação de dicas |
| `--tema escuro` ou `--tema claro` | instala o tema de cores do kit e o escolhe |
| `--plugins a,b` / `--sem a,b` | instala só estes plugins / deixa estes de fora |
| `--janela N` | outra janela de compactação, entre 100000 e 1000000 |
| `--ajuda` | mostra todas as opções |

## Só um plugin, sem o resto

Cada plugin também instala sozinho, pelo comando do Claude Code. Desse jeito não entram a barra de status nem a compactação em 400 mil.

```powershell
claude plugin install alrix-equipe --marketplace alrixbr/alrix-kit
```

Troque `alrix-equipe` por `astra`, `alrix-prompt` ou `alrix-base`.

## Atualizar

Rode de novo a linha de instalação. Os plugins passam a valer na próxima sessão do Claude Code, e a barra é copiada de novo se mudou.

## Desfazer

O instalador mostra esta linha no fim, com o caminho certo do seu computador:

```powershell
node "$HOME\.claude\alrix-kit\instalar.mjs" --desfazer
```

Ela desinstala os plugins que o kit instalou, devolve ao `settings.json` o que havia antes (as chaves que o kit acrescentou saem e o resto não é tocado; se nada mais mudou, o arquivo volta idêntico à cópia de antes) e apaga o que foi copiado. Para só ver o que seria desfeito, acrescente `--simular`.

## Linux e macOS

O instalador é o mesmo, sem a parte do PowerShell. Ele ainda não foi testado nesses sistemas.

```bash
git clone https://github.com/alrixbr/alrix-kit ~/alrix-kit
node ~/alrix-kit/instalar.mjs
```

Instalado assim, o Claude Code guarda a pasta `~/alrix-kit` como a origem dos plugins: não mova nem apague a pasta. Para atualizar, rode `git -C ~/alrix-kit pull` e o instalador de novo.

## Uso e licença

O kit é gratuito. Você pode usar, copiar, mudar e repassar de graça. Não pode vender, nem incluir num produto ou serviço pago. Os termos completos estão no arquivo [LICENSE](LICENSE).
