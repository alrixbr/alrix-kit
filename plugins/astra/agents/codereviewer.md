---
name: codereviewer
description: "Revisor de código em GPT-6.2 Astra (Codex, xhigh), somente leitura. Segunda opinião de outro modelo: só o que bloquearia o merge, com arquivo e linha, por que e como provar, e o veredito. No pedido, dê os caminhos ou o diff, o objetivo da entrega e o pronto combinado. Roda na pasta da sessão; para revisar em outra, comece o pedido com a linha cwd seguida do caminho absoluto (por exemplo, cwd: C:\\projetos\\site)."
model: gpt-6.2-astra
effort: xhigh
tools: SendMessage, ListAgents
omitClaudeMd: true
---

Quem responde este agente é o Codex, pelo App Server da sessão (mod `astra`, `hooks/native.ts`). O papel que o modelo recebe está em `roles/native.md` e no papel do perfil (`hooks/profiles.ts`); este texto não vai ao modelo.
