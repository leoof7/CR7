# Agendamento automático do motor + automações do Cockpit

## Contexto

O motor só rodava uma vez ao subir (arranque) ou quando alguém clicava "Salvar & Rodar" no Cockpit. O usuário vai passar a atualizar o `theo_token` (token diário da planilha fonte) direto no Cockpit e não pretende mais operar o motor manualmente - nem pra rodar, nem pra parar, nem pra sincronizar as Tips no Livro. Este documento cobre 4 mudanças, em `motor.ts` e `index.html`:

1. Agendamento automático de 4 varreduras por dia.
2. Cancelamento seguro de um ciclo em andamento quando o próximo horário bate.
3. Histórico de logs de cada ciclo agendado, substituindo os botões manuais.
4. Sincronização automática de Tips finalizadas para o Livro, substituindo o botão de sync manual.

## 1. Agendamento automático (`motor.ts`)

4 horários fixos, hora de Brasília: **06:00, 16:00, 21:00, 01:00**. Às 06h a raspagem de "hoje" já cobre o dia inteiro desde 00h, então jogos que começaram de madrugada já aparecem com resultado real nesse primeiro ciclo do dia.

Um `setInterval` de 1 minuto compara a hora atual (`agoraSaoPaulo()`, já existente) contra `HORARIOS_AGENDADOS`. Uma chave `"{data} {hora}"` evita disparo duplicado dentro do mesmo minuto.

```ts
const HORARIOS_AGENDADOS = ["06:00", "16:00", "21:00", "01:00"];
let ultimoSlotAgendadoDisparado: string | null = null;

setInterval(() => {
  const agora = agoraSaoPaulo();
  const hhmm = `${String(agora.getHours()).padStart(2, "0")}:${String(agora.getMinutes()).padStart(2, "0")}`;
  if (!HORARIOS_AGENDADOS.includes(hhmm)) return;
  const slot = `${dataLocalStr(agora)} ${hhmm}`;
  if (slot === ultimoSlotAgendadoDisparado) return;
  ultimoSlotAgendadoDisparado = slot;
  dispararCicloAgendado(hhmm).catch(...);
}, 60000);
```

Cada disparo chama `rodarMotorCompleto()` sem token manual - ela já lê sozinha o `theo_token` salvo no Firestore (`configuracoes/motor`), que é exatamente onde o usuário vai manter o token atualizado todo dia. Nenhuma mudança nessa parte.

## 2. Reentrância e cancelamento seguro

Nunca dois ciclos ao mesmo tempo - dois Chromium juntos na instância free de 512MB do Render é risco real de derrubar o processo. Duas flags novas de módulo:

- `motorEmExecucao`: guarda de reentrância no topo de `rodarMotorCompleto()` - se já tem um ciclo rodando, a chamada nova é ignorada (só acontece se o cancelamento falhar, ver abaixo).
- `cancelarVarreduraAtual`: checada em dois pontos do loop de raspagem - no topo do loop de dias (`hoje/ontem/amanha`) e no topo do loop de jogos dentro de cada dia. **Não** é checada no meio de uma navegação do Playwright - fechar o navegador ali já travou o processo inteiro uma vez (histórico documentado no próprio código, seção "DESLIGAMENTO REMOTO").

Quando um horário agendado bate com o ciclo anterior ainda rodando: marca `cancelarVarreduraAtual = true` e espera até 2 minutos o loop perceber e sair sozinho (checkpoint entre um jogo e outro). Se sair a tempo, o ciclo antigo grava status `CANCELADO` e fecha o navegador normalmente; o novo ciclo só começa depois disso. Se não sair em 2 minutos (não deveria acontecer), o horário novo é **pulado** com log de erro, em vez de arriscar dois navegadores simultâneos.

## 3. Histórico de logs (Firestore + Cockpit)

Novo campo `logsAgendados` no doc `configuracoes/motor_status`: lista dos últimos 20 ciclos agendados, cada um com `{ id, horario, data, inicio, fim, status, mensagem }`. Gravado em dois momentos (início e fim de cada `dispararCicloAgendado`), via read-modify-write no array (`registrarLogAgendado`).

No Cockpit, o card que tinha os botões "🛑 Desarmar Motor" (removido) vira um card "⏰ Ciclos Agendados", populado a partir desse mesmo campo, no listener `onSnapshot` que já existe para `motor_status`. Cada linha mostra horário-alvo, data, início→fim e duração, com ícone por status (🔴 executando, 🟢 concluído, 🟡 cancelado, ❌ erro).

De quebra, corrigido um bug preexistente na exibição de status: qualquer coisa que não fosse `EXECUTANDO` (inclusive `ERRO`) aparecia como "🟢 CONCLUÍDO" no badge "Status do Motor Front-End". Agora `ERRO` e `CANCELADO` têm cor e texto próprios.

## 4. Remoção de botões manuais

- **"Salvar & Rodar"** → vira só **"Salvar"**: ainda grava `theo_token`/`apifutebol_key` no Firestore (é onde o usuário atualiza o token diário), mas não dispara mais `forcar_leitura` nem tem a animação de "DESPERTANDO...".
- **"🛑 Desarmar Motor"**: removido do Cockpit, junto com a função `desarmarMotor()` inteira. O listener correspondente em `motor.ts` (`tratarDesligamento` / `desligar_pedido`) continua existindo, inofensivo - não é mais acionado por nada no app, mas segue disponível como rede de segurança via Firestore console se um dia for preciso.
- **"🔄 Sync"** (Tips → Livro): removido. Ver item 5.

## 5. Sincronização automática Tips → Livro

Já existia um gatilho pontual (`autoResolverOperacoesDoJogo`), disparado só no instante em que um jogo específico transiciona pra FT enquanto alguém está com o app aberto. Ele fica como está - reage rápido.

O que muda: `sincronizarTipsNoLivro()` (a varredura completa de todos os jogos finalizados, que só rodava no clique do botão removido) passa a ser chamada automaticamente dentro do debounce de 600ms que já existe no `onSnapshot` de `jogos_ao_vivo` - toda vez que os placares mudam. Isso cobre o que o gatilho pontual pode ter perdido (ex.: jogo terminou com o app fechado). Roda em silêncio (só `console.log`/`console.error`, sem toast) - não tem mais botão nem estado de "sincronizando..." pra mostrar.

## Fora de escopo

- Nenhuma mudança no schema de `jogos_ao_vivo` nem na lógica de raspagem em si.
- Não adiciona um jeito de disparar uma varredura manual avulsa - o usuário confirmou que não vai mais operar isso manualmente.
- Não persiste `logsAgendados` além dos últimos 20 registros (sem paginação/histórico longo).

## Verificação

- `npm run typecheck` limpo (motor.ts usa `@ts-nocheck`, então isso valida só que o arquivo é sintaticamente válido para o compilador).
- `node --check` no JS extraído de `index.html` limpo.
- Motor reiniciado localmente: sobe sem erro, arranque normal (varredura inicial) não é afetada pela guarda de reentrância (começa com `motorEmExecucao = false`).
- **Não testado**: o disparo real de um horário agendado (precisaria esperar bater 06h/16h/21h/01h) e o cancelamento de um ciclo em andamento por sobreposição - a lógica foi revisada linha a linha, mas não houve execução ponta-a-ponta desses dois caminhos.
