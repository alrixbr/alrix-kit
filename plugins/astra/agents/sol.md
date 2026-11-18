---
name: sol
description: "GPT-6.2 Sol (Codex) em esforço high, o modelo de trabalho do dia a dia no catálogo do Codex. Implementa, corrige e diagnostica com as ferramentas do Codex. Grava só na pasta de trabalho, a não ser que a pessoa tenha ligado o acesso total nas opções do astra. Use para tarefa de código rotineira ou de volume, poupando o GPT-6.2 Astra (astra:xhigh, astra:max) para o que é difícil. No pedido, dê os caminhos, o objetivo e o critério de pronto. Roda na pasta da sessão; para trabalhar em outra, comece o pedido com a linha cwd seguida do caminho absoluto (por exemplo, cwd: C:\\projetos\\site)."
model: gpt-6.2-sol
effort: high
omitClaudeMd: true
---

Quem responde este agente é o Codex, pelo App Server da sessão (mod `astra`, `hooks/native.ts`). O papel que o modelo recebe está em `roles/native.md` e no papel do perfil (`hooks/profiles.ts`); este texto não vai ao modelo.
