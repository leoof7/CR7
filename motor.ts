// @ts-nocheck
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import { chromium } from "playwright";
import { execSync } from "child_process";
import * as http from "http";
import * as fs from "fs";

// ⚠️ DEBUG: quando true, o motor abre o Raio-X do PRIMEIRO jogo, salva o HTML
// da área de dados em debug_raiox.txt e PARA (não sincroniza nada no Firestore).
// Serve pra descobrir as classes reais dos títulos de seção do site.
// >>> Volte para false depois de gerar o arquivo. <<<
const DEBUG_RAIOX = false;

// =========================================================================
// SERVIDOR WEB (health check do Render + ping do UptimeRobot)
// =========================================================================
// O Render injeta a porta em process.env.PORT e SÓ considera o deploy saudável se
// o processo escutar nela - porta fixa 8080 faz o serviço ser marcado como
// "no open ports detected". Local, sem a variável, segue em 8080 como sempre.
const PORTA_MOTOR = Number(process.env.PORT) || 8080;
const NO_RENDER = !!process.env.RENDER;

// Navegador da raspagem em uso, se houver. Guardado no escopo do módulo pro
// desligamento remoto conseguir fechá-lo em vez de deixar Chromium órfão.
let navegadorAtivo: any = null;

// Reentrância: nunca dois ciclos de raspagem ao mesmo tempo - dois Chromium juntos
// na instância free de 512MB do Render é risco real de derrubar o processo.
let motorEmExecucao = false;
// Checada entre um jogo e outro (não no meio de uma navegação - fechar o navegador
// ali já travou o processo inteiro uma vez, ver DESLIGAMENTO REMOTO). Setada pelo
// agendador quando um horário novo bate com o ciclo anterior ainda rodando.
let cancelarVarreduraAtual = false;

const servidor = http.createServer((req, res) => {
  const rota = (req.url || "/").split("?")[0];

  if (req.method === "GET" && (rota === "/" || rota === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Motor CR7 Ativo e Rodando!");
    return;
  }

  // Serve o dashboard em http://localhost:8080/app.
  //
  // POR QUE ISSO EXISTE: abrindo o index.html direto pelo disco, a página fica com
  // origem `file://` (origem nula). O Firestore não completa a conexão a partir daí:
  // os onSnapshot nunca entregam nada e os writes ficam pendurados pra sempre - foi
  // o que travou o botão de desarme em "Desarmando..." e deixou o radar preso em
  // "Sincronizando Firebase...", sem erro nenhum na tela. Servido por HTTP, mesmo
  // que localhost, a origem passa a ser válida e tudo funciona.
  if (req.method === "GET" && (rota === "/app" || rota === "/index.html")) {
    fs.readFile(__dirname + "/index.html", (erro, conteudo) => {
      if (erro) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("index.html não encontrado ao lado do motor.ts");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(conteudo);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Rota não encontrada. GET / = status do motor · GET /app = dashboard.");
});

// Sem este handler, porta ocupada virava um "Unhandled 'error' event" com stack
// trace de net.js - parecia defeito no motor quando na verdade é só OUTRA
// instância já rodando. Dois motores ao mesmo tempo é pior do que parece: os dois
// varrem, os dois gastam quota e os dois escrevem no mesmo Firestore.
servidor.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    console.error("=========================================================");
    console.error(`🛑 A PORTA ${PORTA_MOTOR} JÁ ESTÁ EM USO.`);
    console.error("   Já existe um motor rodando - este não vai subir.");
    if (!NO_RENDER) {
      console.error("   Feche a outra janela, ou derrube o processo antigo:");
      console.error(`   PowerShell:  Get-NetTCPConnection -LocalPort ${PORTA_MOTOR} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
    }
    console.error("=========================================================");
  } else {
    console.error(`🛑 Falha no servidor web do motor: ${err.message}`);
  }
  process.exit(1);
});

servidor.listen(PORTA_MOTOR, () => {
  console.log("=========================================================");
  console.log(`🌐 SERVIDOR HTTP PRONTO - escutando na porta ${PORTA_MOTOR}`);
  console.log(`   Ambiente: ${NO_RENDER ? "Render (nuvem)" : "local"}`);
  console.log(`   GET / responde "Motor CR7 Ativo e Rodando!"`);
  if (!NO_RENDER) {
    console.log("");
    console.log(`   👉 ABRA O APP EM:  http://localhost:${PORTA_MOTOR}/app`);
    console.log(`      (abrir o index.html direto do disco NÃO funciona - a origem`);
    console.log(`       file:// impede o Firestore de conectar)`);
  }
  console.log("=========================================================");
});

// Rede/Firestore podem falhar sem derrubar o processo. No Render isso importa: um
// throw solto encerra o container, o deploy vira "Exited with status 1" e o motor
// para de vez. Logar e seguir mantém o serviço no ar pro próximo ciclo.
process.on("unhandledRejection", (motivo: any) => {
  console.error(`⚠️ [NÃO FATAL] Promise rejeitada sem catch: ${motivo?.message || motivo}`);
});
process.on("uncaughtException", (err: any) => {
  console.error(`⚠️ [NÃO FATAL] Exceção não tratada: ${err?.message || err}`);
});

const firebaseConfig = {
  apiKey: "AIzaSyCWiM3pBtP_WwoVS7XHWz6K-DX7GveCQGo",
  authDomain: "crterminalsiu.firebaseapp.com",
  projectId: "crterminalsiu",
  storageBucket: "crterminalsiu.firebasestorage.app",
  messagingSenderId: "964211577075",
  appId: "1:964211577075:web:f0519ee06e81a65c36a786"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
db.settings({ experimentalForceLongPolling: true, useFetchStreams: false });

async function atualizarStatusMotor(dados: object) {
  try {
    await db.collection("configuracoes").doc("motor_status").set(
      { ...dados, atualizadoEm: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {}
}

function normalizarNome(str: string) {
  return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\W/g, '').toLowerCase();
}

// BUG CORRIGIDO (placar e status de jogo alheio):
// o casamento era `(m.includes(api) || api.includes(m))` cru. Como
// normalizarNome(undefined) devolve "" e em JS `"qualquercoisa".includes("")` \u00e9
// SEMPRE true, qualquer item da API sem nome de participante casava com o PRIMEIRO
// jogo do banco (o .find() pega o primeiro) e escrevia nele placar alheio +
// status LIVE - todo jogo ao vivo do mundo era despejado no mesmo documento.
// Agora nome vazio nunca casa, e substring s\u00f3 vale com nome minimamente longo
// (sem isso "as" casaria com meia tabela).
const MIN_CHARS_SUBSTRING = 4;

function casaNomeTime(nomeApi: string, nomeBanco: string) {
  if (!nomeApi || !nomeBanco) return false;
  if (nomeApi === nomeBanco) return true;
  if (Math.min(nomeApi.length, nomeBanco.length) < MIN_CHARS_SUBSTRING) return false;
  return nomeApi.includes(nomeBanco) || nomeBanco.includes(nomeApi);
}

// Acha o jogo do banco correspondente ao item da API. Retorna null quando a API
// n\u00e3o trouxe os dois nomes - preferir N\u00c3O atualizar a atualizar o jogo errado.
function acharJogoNoBanco(jogos: any[], homeApi: string, awayApi: string) {
  if (!homeApi || !awayApi) return null;
  return jogos.find(j =>
    casaNomeTime(homeApi, normalizarNome(j.mandante)) &&
    casaNomeTime(awayApi, normalizarNome(j.visitante))
  ) || null;
}

// =========================================================================
// LIGAS FORA DO ESCOPO (cortadas na raspagem, antes do H2H)
// =========================================================================
// Corta AQUI, e não só no front, porque cada jogo custa navegação de Raio-X +
// H2H no Playwright - o gasto é tempo de motor, não requisição de API.
// ⚠️ Esta lista tem um GÊMEO em index.html (LIGAS_REMOVIDAS / PAISES_REMOVIDOS /
// LIGAS_REMOVIDAS_POR_PAIS). O front continua filtrando pra esconder documento
// antigo que já esteja no Firestore. Mexeu aqui, mexa lá.

function semAcentoUpper(s: string) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
}

// Países cortados por inteiro, em qualquer competição. Os apelidos cobrem grafias
// alternativas do site fonte ("Irão"/"Iran", "República Tcheca"...).
const PAISES_REMOVIDOS = new Set([
  "AZERBAIJAO",
  "BIELORRUSSIA", "BELARUS",
  "BULGARIA",
  "CAZAQUISTAO", "KAZAQUISTAO",
  "COREIA DO SUL",
  "COSTA RICA",
  "ESCOCIA",
  "IRA", "IRAO", "IRAN",
  "TCHEQUIA", "REPUBLICA TCHECA",
  "UCRANIA",
  "CROACIA",
  "AUSTRIA",
  "ESLOVAQUIA",
  "FINLANDIA",
  "HUNGRIA",
  "ISLANDIA",
  "NORUEGA",
  "POLONIA",
  "SUICA",
  "CANADA",
  "CHINA",
  "ESLOVENIA"
]);

// Competições cortadas em qualquer país. O \b depois do "2" impede pegar a
// Champions de verdade ou um "Liga dos Campeões 2024".
const LIGAS_REMOVIDAS = [
  /COPA DA RUSSIA/,
  /COPA DA ESLOVAQUIA/,
  /AFC CHAMPIONS LEAGUE TWO/,
  /LIGA DOS CAMPEOES 2\b/,
  /COPA CENTRO.?AMERICANA/,
  /LIGA DOS CAMPEOES DA OFC/
];

// Pares país + competição: "Primeira Divisão" é nome genérico que aparece em
// dezenas de países, então aqui o país é obrigatório pra não levar liga errada.
const LIGAS_REMOVIDAS_POR_PAIS: Record<string, RegExp[]> = {
  "AFRICA DO SUL": [/PRIMEIRA DIVIS/],
  "BOLIVIA": [/PRIMEIRA DIVIS/],
  "ESTONIA": [/PRIMEIRA DIVIS/],
  "IRLANDA": [/COPA DA IRLANDA/],
  "JAPAO": [/PRIMEIRA DIVIS/],
  "PAIS DE GALES": [/PRIMEIRA DIVIS/]
};

function ligaRemovida(pais: string, competicao: string) {
  const p = semAcentoUpper(pais);
  const c = semAcentoUpper(competicao);
  if (PAISES_REMOVIDOS.has(p)) return true;
  if (LIGAS_REMOVIDAS.some(re => re.test(c))) return true;
  const porPais = LIGAS_REMOVIDAS_POR_PAIS[p];
  if (porPais && porPais.some(re => re.test(c))) return true;

  // Série B (Segunda Divisão) só passa pra Alemanha e Bundesliga 2 e Brasil/
  // Brasileirão Série B - qualquer outro país nessa divisão é cortado.
  const ehSegundaDivisao = c.includes("SEGUNDA DIVIS") || c.includes("SERIE B");
  if (ehSegundaDivisao && !p.includes("BRASIL") && !p.includes("ALEMANHA")) return true;

  // Série C (Terceira Divisão) nunca passa, nem a do Brasil - sem exceção.
  if (c.includes("TERCEIRA DIVIS") || c.includes("SERIE C")) return true;

  return false;
}

// =========================================================================
// GOVERNADOR DE QUOTA DA API-SPORTS (plano FREE: 100 req/dia, 10 req/min)
// =========================================================================
// A API-Sports \u00e9 a \u00daNICA fonte de placar ao vivo. Sem controle, o tick de 5 min
// do sincronizador daria 288 chamadas/dia - quase 3x o limite di\u00e1rio do plano
// free. Este bloco impede isso de tr\u00eas formas:
//   1) OR\u00c7AMENTO DI\u00c1RIO persistido no Firestore (sobrevive a restart do motor);
//   2) TETO POR MINUTO + espa\u00e7amento m\u00ednimo (nunca encosta nos 10/min);
//   3) RITMO ADAPTATIVO: divide as requisi\u00e7\u00f5es que sobraram pelos minutos de
//      jogo que ainda faltam na janela de quota, ent\u00e3o o or\u00e7amento acaba junto
//      com o \u00faltimo jogo do dia em vez de estourar \u00e0s 14h.
// A quota reseta \u00e0s 00:00 UTC = 21:00 de Bras\u00edlia, por isso a "janela" \u00e9
// identificada pela DATA EM UTC, n\u00e3o pela data local.
const API_SPORTS_LIMITE_DIA = 100;
const API_SPORTS_RESERVA = 10;   // guardado pro bot\u00e3o "Testar Conex\u00f5es" e imprevistos
const API_SPORTS_ORCAMENTO = API_SPORTS_LIMITE_DIA - API_SPORTS_RESERVA;
const API_SPORTS_TETO_POR_MINUTO = 6;      // limite real \u00e9 10 - fica folga
const API_SPORTS_ESPACO_MINIMO_MS = 8000;  // nunca duas chamadas em menos de 8s
const API_SPORTS_INTERVALO_MIN = 4;        // minutos - piso do ritmo adaptativo
const API_SPORTS_INTERVALO_MAX = 30;       // minutos - teto do ritmo adaptativo
const API_SPORTS_COOLDOWN_MANUAL_MS = 30000; // trava anti-clique-repetido no teste do Cockpit

// Faixas (em minutos de UTC no dia) em que existem jogos rolando, considerando
// jogos das 09:00 at\u00e9 a meia-noite de Bras\u00edlia (UTC-3):
//   UTC 00:00-03:00  = 21:00-00:00 local (fim da noite)
//   UTC 12:00-24:00  = 09:00-21:00 local (manh\u00e3 at\u00e9 a noite)
// Total: 900 min de jogo por janela de quota -> 90 req / 900 min = 1 a cada 10 min.
const JANELA_JOGOS_UTC: [number, number][] = [[0, 180], [720, 1440]];

function minutoDoDiaUTC(agora = new Date()) {
  return agora.getUTCHours() * 60 + agora.getUTCMinutes();
}

function minutosDeJogoRestantes(agora = new Date()) {
  const m = minutoDoDiaUTC(agora);
  return JANELA_JOGOS_UTC.reduce((soma, [ini, fim]) => soma + Math.max(0, fim - Math.max(ini, m)), 0);
}

function minutosAteResetQuota(agora = new Date()) {
  return 1440 - minutoDoDiaUTC(agora);
}

function agoraSaoPaulo() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
}

function dataLocalStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Conta quantos jogos justificam gastar uma requisi\u00e7\u00e3o AGORA. Sem nenhum jogo
// rolando n\u00e3o existe placar pra atualizar - a chamada seria desperd\u00edcio puro.
// Considera LIVE j\u00e1 marcado ou jogo de hoje cujo hor\u00e1rio come\u00e7ou nos \u00faltimos
// 150 min (90 de bola rolando + intervalo + acr\u00e9scimos).
function contarJogosEmAndamento(jogos: any[]) {
  const agora = agoraSaoPaulo();
  const hoje = dataLocalStr(agora);
  const ontem = dataLocalStr(new Date(agora.getTime() - 86400000));
  const minAgora = agora.getHours() * 60 + agora.getMinutes();
  let total = 0;

  for (const j of jogos) {
    const st = String(j.status || '').toUpperCase();
    if (st.includes('FT') || st.includes('ENC') || st.includes('FIN')) continue;

    if (st.includes('LIVE')) {
      // Um LIVE preso de dias atr\u00e1s n\u00e3o pode manter o poller aceso pra sempre:
      // s\u00f3 vale se for de hoje, ou de ontem antes das 03:00 (jogo que virou o dia).
      if (j.dataJogo === hoje || (j.dataJogo === ontem && minAgora < 180)) total++;
      continue;
    }

    if (j.dataJogo !== hoje) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(j.hora || ''));
    if (!m) continue;
    const inicio = Number(m[1]) * 60 + Number(m[2]);
    if (inicio === 0) continue; // "00:00" \u00e9 o sentinela de hor\u00e1rio desconhecido
    const decorrido = minAgora - inicio;
    if (decorrido >= -10 && decorrido <= 150) total++;
  }
  return total;
}

let quotaCache: { janela: string; usadas: number; ultimaMs: number } | null = null;
let chamadasNoMinuto: number[] = [];

async function lerQuotaApiSports() {
  const janela = new Date().toISOString().slice(0, 10); // data UTC = id da janela
  if (quotaCache && quotaCache.janela === janela) return quotaCache;
  try {
    const doc = await db.collection("configuracoes").doc("api_sports_quota").get();
    const d: any = doc.data() || {};
    quotaCache = d.janela === janela
      ? { janela, usadas: Number(d.usadas) || 0, ultimaMs: Number(d.ultimaMs) || 0 }
      : { janela, usadas: 0, ultimaMs: 0 };
  } catch (e) {
    // Sem leitura do Firestore, come\u00e7a conservador (assume janela nova e zerada)
    quotaCache = quotaCache && quotaCache.janela === janela ? quotaCache : { janela, usadas: 0, ultimaMs: 0 };
  }
  return quotaCache;
}

function resumoQuota(usadas: number) {
  const faltaReset = minutosAteResetQuota();
  const h = Math.floor(faltaReset / 60);
  const min = faltaReset % 60;
  return `${usadas}/${API_SPORTS_LIMITE_DIA} hoje \u00b7 auto at\u00e9 ${API_SPORTS_ORCAMENTO} \u00b7 reset em ${h}h${String(min).padStart(2, '0')}`;
}

// Decide se a chamada pode sair. Retorna { ok, motivo } - o motivo vai pro log e
// pro cockpit, ent\u00e3o d\u00e1 pra auditar exatamente por que uma requisi\u00e7\u00e3o foi poupada.
// `manual = true` \u00e9 o teste do Cockpit: pode entrar na RESERVA (as 10 req que o
// ciclo autom\u00e1tico nunca toca) e ignora o ritmo adaptativo, porque quem clicou
// quer resposta agora. O que ele N\u00c3O ignora \u00e9 o limite real de 100/dia nem o
// teto por minuto - esses valem pra todo mundo.
async function autorizarChamadaApiSports(jogosEmAndamento: number, manual = false) {
  const q = await lerQuotaApiSports();
  const agora = Date.now();
  const teto = manual ? API_SPORTS_LIMITE_DIA : API_SPORTS_ORCAMENTO;
  const restantes = teto - q.usadas;

  if (restantes <= 0) {
    const motivo = manual
      ? `limite di\u00e1rio de ${API_SPORTS_LIMITE_DIA} req atingido (${resumoQuota(q.usadas)})`
      : `or\u00e7amento autom\u00e1tico esgotado (${resumoQuota(q.usadas)})`;
    return { ok: false, motivo, usadas: q.usadas };
  }
  if (!manual && jogosEmAndamento === 0) {
    return { ok: false, motivo: `nenhum jogo em andamento - requisi\u00e7\u00e3o poupada (${resumoQuota(q.usadas)})`, usadas: q.usadas };
  }

  chamadasNoMinuto = chamadasNoMinuto.filter(t => agora - t < 60000);
  if (chamadasNoMinuto.length >= API_SPORTS_TETO_POR_MINUTO) {
    return { ok: false, motivo: `teto de ${API_SPORTS_TETO_POR_MINUTO} req/min atingido`, usadas: q.usadas };
  }

  const espacoMinimo = manual ? API_SPORTS_COOLDOWN_MANUAL_MS : API_SPORTS_ESPACO_MINIMO_MS;
  if (q.ultimaMs && agora - q.ultimaMs < espacoMinimo) {
    const faltam = Math.ceil((espacoMinimo - (agora - q.ultimaMs)) / 1000);
    return { ok: false, motivo: `aguarde ${faltam}s (espa\u00e7amento m\u00ednimo de ${espacoMinimo / 1000}s entre chamadas)`, usadas: q.usadas };
  }

  if (manual) {
    return { ok: true, motivo: `teste manual \u00b7 ${resumoQuota(q.usadas)}`, usadas: q.usadas };
  }

  const minutosJogo = Math.max(minutosDeJogoRestantes(), 1);
  const intervaloIdeal = Math.min(
    API_SPORTS_INTERVALO_MAX,
    Math.max(API_SPORTS_INTERVALO_MIN, minutosJogo / restantes)
  );
  if (q.ultimaMs && agora - q.ultimaMs < intervaloIdeal * 60000) {
    const faltam = Math.ceil((intervaloIdeal * 60000 - (agora - q.ultimaMs)) / 60000);
    return { ok: false, motivo: `ritmo adaptativo: 1 req a cada ${intervaloIdeal.toFixed(1)} min (libera em ~${faltam} min)`, usadas: q.usadas };
  }

  return { ok: true, motivo: `ritmo ${intervaloIdeal.toFixed(1)} min \u00b7 ${resumoQuota(q.usadas)}`, usadas: q.usadas };
}

// Debita ANTES do fetch: erro de rede e resposta 4xx tamb\u00e9m consomem quota na
// API-Sports, e assim uma falha em loop n\u00e3o vira gasto descontrolado.
async function debitarChamadaApiSports() {
  const q = await lerQuotaApiSports();
  q.usadas += 1;
  q.ultimaMs = Date.now();
  chamadasNoMinuto.push(q.ultimaMs);
  try {
    await db.collection("configuracoes").doc("api_sports_quota").set(
      { janela: q.janela, usadas: q.usadas, ultimaMs: q.ultimaMs, atualizadoEm: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {}
  return q;
}

// Zera o orçamento restante da janela atual. Usado quando a própria API avisa que
// o limite acabou (HTTP 429 ou `errors.requests`) - a partir daí qualquer chamada
// nova só serve pra chamar atenção, então o motor para até o reset das 21:00.
async function queimarOrcamentoApiSports(motivo: string) {
  const q = await lerQuotaApiSports();
  q.usadas = API_SPORTS_ORCAMENTO;
  q.ultimaMs = Date.now();
  console.log(`🛑 [API-SPORTS] Orçamento congelado até o reset - ${motivo}`);
  try {
    await db.collection("configuracoes").doc("api_sports_quota").set(
      { janela: q.janela, usadas: q.usadas, ultimaMs: q.ultimaMs, congeladoPor: motivo, atualizadoEm: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {}
  await atualizarStatusMotor({ statusQuotaApiSports: `🛑 API-Sports congelada (${motivo}) · ${resumoQuota(q.usadas)}` });
}

// Fonte ÚNICA de placar ao vivo: API-Sports. A Sportmonks saiu do projeto.
// `live=all` devolve TODOS os jogos ao vivo do mundo numa requisição - com events,
// porque a API inclui events/lineups/statistics quando se usa id/ids/live. O custo
// é por CICLO, nunca por jogo.
//
// `manual = true` vem do botão 🔄 do card. Ele faz exatamente a mesma requisição
// completa (atualiza TODOS os jogos casados, não só o clicado) e passa pelo mesmo
// débito de quota. E como o débito grava `ultimaMs`, o ritmo automático volta a
// contar A PARTIR DO CLIQUE: o clique substitui o próximo ciclo em vez de somar
// com ele, então checar o placar na mão não custa requisição extra no fim do dia.
async function sincronizarAoVivoBackend(manual = false) {
  try {
    const configDoc = await db.collection("configuracoes").doc("motor").get();
    const config = configDoc.data() || {};
    const asKey = config.apifutebol_key || "a1d3726b4534be5d0d6c091ad598b242";
    if (!asKey) return { ok: false, mensagem: "Sem chave da API-Sports na Sala de Máquinas." };

    const snapshotJogos = await db.collection("jogos_ao_vivo").get();
    if (snapshotJogos.empty) return { ok: false, mensagem: "Nenhum jogo no banco pra atualizar." };

    const jogosAtuais: any[] = [];
    snapshotJogos.forEach(doc => jogosAtuais.push(doc.data()));

    const jogosEmAndamento = contarJogosEmAndamento(jogosAtuais);
    const permissao = await autorizarChamadaApiSports(jogosEmAndamento, manual);

    if (!permissao.ok) {
      console.log(`⏸️ [API-SPORTS] Chamada evitada: ${permissao.motivo}`);
      await atualizarStatusMotor({ statusQuotaApiSports: `⏸️ API-Sports em espera · ${resumoQuota(permissao.usadas)}` });
      return { ok: false, mensagem: permissao.motivo, quota: resumoQuota(permissao.usadas) };
    }

    const quota = await debitarChamadaApiSports();
    console.log(`🎟️ [API-SPORTS] ${manual ? "Atualização manual" : "Ciclo automático"}: 1 requisição (${jogosEmAndamento} jogo(s) em andamento) · ${permissao.motivo}`);
    await atualizarStatusMotor({ statusQuotaApiSports: `🎟️ API-Sports ${resumoQuota(quota.usadas)}` });

    try {
      const resAS = await fetch(`https://v3.football.api-sports.io/fixtures?live=all`, {
        headers: { 'x-apisports-key': asKey }
      });

      if (!resAS.ok) {
        console.log(`🔴 [API LIVE] Erro na API-Sports. Status: ${resAS.status}`);
        // 429 = estourou req/min ou req/dia. Congela até o próximo reset em vez
        // de insistir - insistir num 429 é o caminho mais rápido pro bloqueio.
        if (resAS.status === 429) await queimarOrcamentoApiSports("HTTP 429 (rate limit)");
        await atualizarStatusMotor({ statusApiLive: `🔴 Erro API-Sports: status ${resAS.status}` });
        return { ok: false, mensagem: `API-Sports respondeu ${resAS.status}.`, quota: resumoQuota(quota.usadas) };
      }

      const jsonAS = await resAS.json();

      // A API-Sports devolve 200 mesmo quando recusa: os problemas vêm em `errors`
      // (limite diário, IP/domínio não autorizado, chave inválida). Sem tratar isso,
      // o motor acharia que "deu certo" e seguiria queimando requisições contra uma
      // chave já bloqueada.
      const erros = jsonAS.errors;
      const temErro = Array.isArray(erros) ? erros.length > 0 : erros && Object.keys(erros).length > 0;
      if (temErro) {
        const detalhe = JSON.stringify(erros);
        console.log(`🔴 [API-SPORTS] Recusada pela API: ${detalhe}`);
        if (/requests|limit|plan/i.test(detalhe)) await queimarOrcamentoApiSports("limite reportado pela própria API");
        await atualizarStatusMotor({ statusApiLive: `🔴 Erro API-Sports: ${detalhe.slice(0, 120)}` });
        return { ok: false, mensagem: `API-Sports recusou: ${detalhe.slice(0, 120)}`, quota: resumoQuota(quota.usadas) };
      }

      const ativos = Array.isArray(jsonAS.response) ? jsonAS.response.length : 0;
      console.log(`🟢 [API LIVE] API-Sports OK! Retornou ${ativos} jogos ativos.`);

      let atualizados = 0;
      for (const item of (jsonAS.response || [])) {
        const hName = normalizarNome(item.teams?.home?.name);
        const aName = normalizarNome(item.teams?.away?.name);
        const hScore = item.goals?.home || 0;
        const aScore = item.goals?.away || 0;
        const min = item.fixture?.status?.elapsed || "LIVE";

        const eventos = Array.isArray(item.events) ? item.events : [];
        const golsEvt = eventos.filter((e: any) => e.type === 'Goal');
        const vermelhosEvt = eventos.filter((e: any) => e.type === 'Card' && (e.detail || '').toUpperCase().includes('RED'));
        const subsEvt = eventos.filter((e: any) => e.type === 'subst' || e.type === 'Subst');

        // Lista completa de quem marcou (não só o último) - com time, minuto e
        // tempo (1T/2T, derivado do minuto) pra alimentar a aba "Quem Fez o Gol"
        // E pra validar green/red dos métodos HT/2T mesmo quando o placar de
        // intervalo raspado do site (golsHTCasa/Fora) não estiver disponível.
        const golsDetalhados = golsEvt.map((e: any) => {
          const minuto = e.time?.elapsed ?? null;
          return {
            jogador: e.player?.name || "Desconhecido",
            time: e.team?.id === item.teams?.home?.id ? 'casa' : 'fora',
            minuto,
            tempo: (minuto !== null && minuto <= 45) ? '1T' : '2T'
          };
        });
        const lastGoalScorer = golsEvt.length ? (golsEvt[golsEvt.length - 1].player?.name || "") : "";
        const vermelhoCasa = vermelhosEvt.filter((e: any) => e.team?.id === item.teams?.home?.id).length;
        const vermelhoFora = vermelhosEvt.length - vermelhoCasa;
        const ultimoVermelho = vermelhosEvt.length ? (vermelhosEvt[vermelhosEvt.length - 1].player?.name || "") : "";
        const ultimaSubstituicao = subsEvt.length ? (subsEvt[subsEvt.length - 1].player?.name || "") : "";

        const match = acharJogoNoBanco(jogosAtuais, hName, aName);
        if (!match) continue;

        await db.collection('jogos_ao_vivo').doc(String(match.id)).set({
          golsCasa: hScore, golsFora: aScore, status: 'LIVE', minutoAoVivo: `${min}'`,
          ultimoGol: lastGoalScorer, golsDetalhados: golsDetalhados,
          cartaoVermelhoCasa: vermelhoCasa, cartaoVermelhoFora: vermelhoFora, ultimoCartaoVermelho: ultimoVermelho,
          totalSubstituicoes: subsEvt.length, ultimaSubstituicao: ultimaSubstituicao,
          eventosAoVivoAtualizadoEm: new Date().toISOString()
        }, { merge: true });
        atualizados++;
      }

      await atualizarStatusMotor({ statusApiLive: `🟢 API-Sports OK (Última: ${new Date().toLocaleTimeString()})` });
      return {
        ok: true,
        atualizados,
        ativos,
        mensagem: `${atualizados} jogo(s) do seu radar atualizado(s) (${ativos} ao vivo na API).`,
        quota: resumoQuota(quota.usadas)
      };
    } catch (e) {
      console.log(`🔴 [API LIVE] Falha na rede API-Sports: ${(e as Error).message}`);
      return { ok: false, mensagem: `Falha de rede na API-Sports: ${(e as Error).message}`, quota: resumoQuota(quota.usadas) };
    }
  } catch (err) {
    console.log("Erro no sync live", err);
    return { ok: false, mensagem: `Erro no sync: ${(err as Error).message}` };
  }
}

// Tick automático de 5 min. O governador de quota é quem decide se a requisição
// sai de fato - este intervalo é só a oportunidade de tentar.
setInterval(() => { sincronizarAoVivoBackend(false); }, 300000);

async function rodarMotorCompleto(theoTokenManual: string | null = null) {
  if (motorEmExecucao) {
    console.log("⏭️  Ciclo já em andamento - chamada ignorada (o cancelamento deveria ter esvaziado isso antes de chamar de novo).");
    return;
  }
  motorEmExecucao = true;
  cancelarVarreduraAtual = false;

  const inicioMs = Date.now();

  let tokenTheo = theoTokenManual;
  if (!tokenTheo) {
    try {
      const configDoc = await db.collection("configuracoes").doc("motor").get();
      if (configDoc.exists) {
        tokenTheo = configDoc.data()?.theo_token || "afba4f6a53";
      }
    } catch (e) {
      tokenTheo = "afba4f6a53";
    }
  }

  console.log("\n==================================================");
  console.log(`🚀 [CR7 MOTOR] INICIANDO VARREDURA (HOJE, ONTEM, AMANHÃ)...`);
  console.log("==================================================");

  await atualizarStatusMotor({
    status: "EXECUTANDO",
    inicioTimestamp: inicioMs,
    mensagem: "Iniciando navegador para ciclo de testes...",
    jogosProcessados: 0,
    jogosTotais: 0,
  });

  let browser;
  try {
    let execPath = undefined;
    // (navegadorAtivo é preenchido logo após o launch, pro desligamento remoto
    //  conseguir fechar o Chromium em vez de deixar processo órfão)
    if (process.platform !== "win32") {
      try {
        execPath = execSync("which chromium").toString().trim();
      } catch (e) {}
    }

    const launchOptions = {
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    };
    if (execPath) launchOptions.executablePath = execPath;

    browser = await chromium.launch(launchOptions);
    navegadorAtivo = browser;
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

    // O tsx/esbuild compila as funções passadas ao page.evaluate com o helper
    // __name() (opção keepNames). Esse helper só existe no escopo do Node, não
    // dentro da página - sem este shim o evaluate quebra com
    // "ReferenceError: __name is not defined".
    // Passado como string de propósito: se fosse uma função TS, o próprio esbuild
    // poderia instrumentá-la com __name e o shim quebraria antes de existir.
    await context.addInitScript({
      content: "if (typeof window.__name === 'undefined') { window.__name = function (fn) { return fn; }; }"
    });

    const page = await context.newPage();

    const diasParaRaspar = ['hoje', 'ontem', 'amanha'];
    let totalJogosNaRodada = 0;
    let jaCapturouDebugH2HAmbos = false; // só grava 1x por execução, não a cada jogo

    for (const diaAlvo of diasParaRaspar) {
        if (cancelarVarreduraAtual) { console.log("🛑 Varredura cancelada (novo horário agendado assumiu)."); break; }

        console.log(`\n==================================================`);
        console.log(`📅 PREPARANDO RASPAGEM DO DIA: ${diaAlvo.toUpperCase()}`);
        console.log(`==================================================`);

        const refDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        if (diaAlvo === 'amanha') refDate.setDate(refDate.getDate() + 1);
        if (diaAlvo === 'ontem') refDate.setDate(refDate.getDate() - 1);
        const dataSalvarDB = `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, '0')}-${String(refDate.getDate()).padStart(2, '0')}`;

        const urlAlvo = `https://clube.theoborges.com/matches?dia=${diaAlvo}&t=${tokenTheo}`;
        console.log(`🔍 [NAVEGAÇÃO] Acessando URL: ${urlAlvo}`);
        await page.goto(urlAlvo, { waitUntil: "domcontentloaded", timeout: 90000 });

        console.log("⏳ [AGUARDANDO SPA] Esperando grade de ligas carregar (15s)...");
        await page.waitForTimeout(15000);

        console.log("🔓 [AÇÃO] Expandindo todas as ligas (Sanfonas) fechadas...");
        await page.evaluate(async () => {
          const headers = Array.from(document.querySelectorAll("div, span, p")).filter((el) => {
            if (el.closest('aside, .right-column, [class*="sidebar"]')) return false;
            if (el.closest('a')) return false; 
            const txt = (el.innerText || "").trim();
            return txt.includes(" - ") && txt.length < 80 && !txt.includes(":");
          });

          for (const header of headers) {
            let parent = header.parentElement;
            let limit = 5;
            while (parent && limit > 0) {
              if (parent.tagName === "DIV" && (parent.className.includes("flex") || parent.className.includes("header") || parent.className.includes("card"))) {
                if (parent.querySelector('a[href*="/game/"], a[href*="/match/"]')) break;
                try { parent.click(); } catch (e) {}
                break;
              }
              parent = parent.parentElement;
              limit--;
            }
          }
        });

        console.log("✅ Ligas expandidas! Executando auto-scroll...");
        await page.waitForTimeout(3000);

        await page.evaluate(async () => {
          await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 400;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= scrollHeight) {
                clearInterval(timer);
                resolve();
              }
            }, 200); 
          });
        });
        
        console.log("⏳ [AGUARDANDO] Esperando rendering do final da página (5s)...");
        await page.waitForTimeout(5000);

        const resultadoGrade = await page.evaluate((dbDate) => {
          const jogosExtraidos = [];
          const descartados = []; // linkEl.outerHTML de partidas sem mandante/visitante - pra diagnosticar sem chute
          const matchMap = new Set();
          
          const destaquesSet = new Set();
          document.querySelectorAll('.right-column a[href*="/game/"], [class*="sidebar"] a[href*="/game/"], aside a[href*="/game/"]').forEach(a => {
              const href = typeof a.href === 'string' ? a.href : a.getAttribute('href') || '';
              const mId = href.split("/").pop().split("?")[0];
              if (mId) destaquesSet.add(mId);
          });

          const allMatchLinks = Array.from(document.querySelectorAll('a[href*="/game/"], a[href*="/match/"]'));

          allMatchLinks.forEach((linkEl) => {
            if (linkEl.closest('aside, .right-column, [class*="sidebar"]')) return;

            const href = typeof linkEl.href === "string" ? linkEl.href : linkEl.getAttribute("href") || "";
            if (!href) return;

            const matchId = href.split("/").pop().split("?")[0];
            if (!matchId || matchMap.has(matchId)) return;

            let pais = "Internacional", competicao = "Geral", achouLiga = false;
            let containerDoJogo = linkEl.parentElement;

            while (containerDoJogo && containerDoJogo.tagName !== "BODY") {
              let irmaoAnterior = containerDoJogo.previousElementSibling;
              while (irmaoAnterior) {
                const txt = irmaoAnterior.innerText || "";
                if (txt.includes(" - ") && txt.length < 80) {
                  const primeiraLinha = txt.split("\n")[0].replace(/\s+\d+$/, "").trim();
                  const partes = primeiraLinha.split(" - ");
                  if (partes.length >= 2) {
                    pais = partes[0].trim();
                    competicao = partes.slice(1).join(" - ").trim();
                    achouLiga = true;
                    break;
                  }
                }
                irmaoAnterior = irmaoAnterior.previousElementSibling;
              }
              if (achouLiga) break;
              containerDoJogo = containerDoJogo.parentElement;
            }

            const compStrSegura = String(competicao || "Geral").toUpperCase();
            if (compStrSegura.includes("FAVORITOS") || compStrSegura.includes("CLÁSSICOS") || compStrSegura.includes("ADICIONAR")) return;

            const paisStrSegura = String(pais || "").toUpperCase();
            if (compStrSegura.includes("SEGUNDA DIVIS") || compStrSegura.includes("SÉRIE B") || compStrSegura.includes("SERIE B")) {
              // Só passa Série B/Segunda Divisão quando for Brasileirão Série B ou Bundesliga 2 -
              // o nome da competição vem genérico ("Segunda Divisão"/"Série B"), então quem
              // distingue a liga é o país, não a palavra "Brasileirão"/"Bundesliga" no texto
              const ehBrasileiraoB = paisStrSegura.includes("BRASIL");
              const ehBundesliga2 = paisStrSegura.includes("ALEMANHA");
              if (!ehBrasileiraoB && !ehBundesliga2) return;
            }

            let mandante = "", visitante = "";
            const teamEls = linkEl.querySelectorAll('[class*="team-name"], [class*="name"]');
            if (teamEls.length >= 2) {
              mandante = teamEls[0].innerText.trim();
              visitante = teamEls[teamEls.length - 1].innerText.trim();
            }

            // Descarta nome de time que na verdade veio como o nome da liga (ex.: "(Premier Soccer League)")
            // ou como ruído de data/hora do card ("14:30", "11/08", "11 Aug", "Terça-feira") -
            // cada formato novo que aparecia furava o filtro anterior (que só pegava um
            // formato por vez), então agora é uma checagem única e mais ampla, reaproveitada
            // tanto pro seletor principal quanto pro fallback de texto solto.
            const MESES_ABREV = /^(jan|fev|feb|mar|abr|apr|mai|may|jun|jul|ago|aug|set|sep|out|oct|nov|dez|dec)\.?$/i;
            const DIAS_SEMANA = /^(seg|ter|qua|qui|sex|s[aá]b|dom|mon|tue|wed|thu|fri|sat|sun)(-feira)?$/i;
            const pareceRuido = (t: string) => {
              if (!t) return true;
              const s = t.trim();
              if (/^\(.*\)$/.test(s) || s.toUpperCase() === compStrSegura) return true; // nome da liga
              if (/^[\d.,]+$/.test(s)) return true; // odd solta ("2.50")
              if (/^\d{1,2}:\d{2}$/.test(s)) return true; // hora ("14:30")
              if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(s)) return true; // data numérica ("11/08")
              const partesData = s.split(/\s+/);
              if (partesData.length === 2 && /^\d{1,2}$/.test(partesData[0]) && MESES_ABREV.test(partesData[1])) return true; // "11 Aug" / "11 Ago"
              if (DIAS_SEMANA.test(s)) return true; // "Terça-feira", "Seg"
              return false;
            };

            if (pareceRuido(mandante)) mandante = "";
            if (pareceRuido(visitante)) visitante = "";

            if (!mandante || !visitante) {
              const txts = (linkEl.innerText || "").split("\n").map((s) => s.trim()).filter((t) => t.length > 2 && !pareceRuido(t));
              if (txts.length >= 2) {
                mandante = txts[0];
                visitante = txts[txts.length - 1];
              }
            }

            let logoCasa = "", logoFora = "";
            const imgs = linkEl.querySelectorAll("img");
            if (imgs.length >= 2) {
              logoCasa = imgs[0].src || imgs[0].getAttribute("data-src") || "";
              logoFora = imgs[1].src || imgs[1].getAttribute("data-src") || "";
            }

            const oddElements = Array.from(linkEl.querySelectorAll('[class*="odd"], .market-cell, button'));
            const oddValues = oddElements.map((el) => (el.innerText || "").trim()).filter((val) => /^[0-9.]+$/.test(val));
            let oddCasa = "0.00", oddEmpate = "0.00", oddFora = "0.00";

            if (oddValues.length >= 3) {
              oddCasa = oddValues[0]; oddEmpate = oddValues[1]; oddFora = oddValues[2];
            } else if (oddValues.length === 2) {
              oddCasa = oddValues[0]; oddFora = oddValues[1];
            }

            const rawText = (linkEl.innerText || "").toUpperCase();
            let status = "NS";
            if (rawText.includes("FINALIZ") || rawText.includes("FT") || rawText.includes("ENCERR")) {
              status = "FT";
            } else if (rawText.includes("AO VIVO") || rawText.includes("LIVE") || rawText.includes("'")) {
              status = "LIVE";
            } else if (rawText.includes("HT") || rawText.includes("INTERVALO")) {
              status = "HT";
            }

            // ".match-kickoff-time" é o horário AGENDADO do jogo (visto no debug de
            // partidas não iniciadas) - fica primeiro na busca porque, ao vivo/
            // finalizado, o site troca o conteúdo do elemento genérico de "time"
            // pelo minuto corrido ("45'") ou o placar, não pelo horário de início.
            // O seletor genérico ".match-time, [class*=\"time\"]" continua como
            // fallback pra não regredir se essa classe específica não existir.
            const timeEl = linkEl.querySelector('.match-kickoff-time, .match-time, [class*="time"]');
            let hora = timeEl ? (timeEl.innerText || "").trim() : "";
            if (!hora || !/^\d{1,2}:\d{2}$/.test(hora)) {
              hora = "00:00";
            }

            let golsCasa = 0, golsFora = 0;
            const scoreEl = linkEl.querySelector('.match-score, [class*="score"]');
            if (scoreEl && (scoreEl.innerText || "").includes("-")) {
              const parts = scoreEl.innerText.split("-");
              golsCasa = parseInt(parts[0].trim()) || 0;
              golsFora = parseInt(parts[1].trim()) || 0;
            }

            const isDestaque = destaquesSet.has(matchId);

            if (mandante && visitante) {
              matchMap.add(matchId);
              jogosExtraidos.push({ id: matchId, pais, competicao, mandante, visitante, logoCasa, logoFora, oddCasa, oddEmpate, oddFora, status, hora, golsCasa, golsFora, dataJogo: dbDate, link: href, isDestaque });
            } else if (descartados.length < 15) {
              // Guarda só os primeiros 15 pra não inchar o arquivo - o bug se repete
              // com o mesmo padrão de markup, não precisa de todos os casos.
              descartados.push({ matchId, mandanteAchado: mandante, visitanteAchado: visitante, html: linkEl.outerHTML });
            }
          });

          return { jogos: jogosExtraidos, descartados };
        }, dataSalvarDB);

        // Corta as ligas fora de escopo ANTES do loop de detalhes: cada jogo aqui
        // custa 2 navegações no Playwright (Raio-X + H2H), então filtrar depois
        // seria pagar o preço todo pra jogar o dado no lixo.
        const jogosBrutos = resultadoGrade.jogos;
        const listaEstruturada = jogosBrutos.filter(j => !ligaRemovida(j.pais, j.competicao));
        const cortados = jogosBrutos.length - listaEstruturada.length;

        totalJogosNaRodada += listaEstruturada.length;
        console.log(`📌 [MAPA DO DIA ${diaAlvo.toUpperCase()}]: Encontradas ${listaEstruturada.length} partidas` + (cortados > 0 ? ` (${cortados} cortada(s) por liga fora de escopo)` : ``));

        if (resultadoGrade.descartados.length > 0) {
          const corpoDebug = resultadoGrade.descartados.map((d, i) =>
            `\n${"=".repeat(80)}\n#${i + 1} matchId=${d.matchId} mandanteAchado="${d.mandanteAchado}" visitanteAchado="${d.visitanteAchado}"\n${"=".repeat(80)}\n${d.html}`
          ).join("\n");
          fs.writeFileSync(`debug_jogos_sem_nome_${diaAlvo}.txt`, corpoDebug, "utf8");
          console.log(`⚠️ [DEBUG] ${resultadoGrade.descartados.length} partida(s) sem nome de time - HTML salvo em debug_jogos_sem_nome_${diaAlvo}.txt`);
        }

        let count = 0;
        for (const item of listaEstruturada) {
          if (cancelarVarreduraAtual) { console.log("🛑 Varredura cancelada (novo horário agendado assumiu)."); break; }
          count++;
          try {
            let linkAutenticado = String(item.link || "");
            if (!linkAutenticado) continue;

            if (!linkAutenticado.includes("t=")) {
              const conector = linkAutenticado.includes("?") ? "&" : "?";
              linkAutenticado = `${linkAutenticado}${conector}t=${tokenTheo}`;
            }

            console.log(`\n[${diaAlvo.toUpperCase()} | ${count}/${listaEstruturada.length}] ⚽ Raspando Detalhes: ${item.mandante} x ${item.visitante}`);

            await page.goto(linkAutenticado, { waitUntil: "domcontentloaded", timeout: 90000 });
            await page.waitForTimeout(4000); 

            const headerInfo = await page.evaluate(() => {
              let topAreaText = (document.body.innerText || "").substring(0, 400);
              const upperTop = topAreaText.toUpperCase();
              const isFT = upperTop.includes("FINALIZADA") || upperTop.includes("ENCERRADO") || upperTop.includes("FT");
              const isLIVE = upperTop.includes("AO VIVO") || upperTop.includes("EM ANDAMENTO") || upperTop.includes("HT");
              const isNS = upperTop.includes("AGENDADA") || upperTop.includes("AGENDADO");

              const scoreMatch = topAreaText.match(/(\d+)\s*-\s*(\d+)/);
              let gc = null, gf = null;
              if (scoreMatch && (isFT || isLIVE)) {
                gc = parseInt(scoreMatch[1], 10);
                gf = parseInt(scoreMatch[2], 10);
              }

              // Placar do intervalo (HT) - nunca inventar: só grava se achar um padrão explícito.
              let htCasa = null, htFora = null;
              const parenMatch = topAreaText.match(/\d+\s*-\s*\d+\s*\((\d+)\s*-\s*(\d+)\)/);
              const intervaloMatch = topAreaText.match(/INTERVALO[:\s]*(\d+)\s*-\s*(\d+)/i);
              const htLabelMatch = topAreaText.match(/\bHT[:\s]*(\d+)\s*-\s*(\d+)/i);
              const htMatch = parenMatch || intervaloMatch || htLabelMatch;
              if (htMatch) {
                htCasa = parseInt(htMatch[1], 10);
                htFora = parseInt(htMatch[2], 10);
              }

              return { isFT, isLIVE, isNS, gc, gf, htCasa, htFora };
            });

            if (headerInfo.isFT) item.status = "FT";
            else if (headerInfo.isLIVE) item.status = "LIVE";
            else if (headerInfo.isNS) item.status = "NS";

            if (headerInfo.gc !== null && !isNaN(headerInfo.gc)) item.golsCasa = headerInfo.gc;
            else if (item.status === "NS") item.golsCasa = 0;

            if (headerInfo.gf !== null && !isNaN(headerInfo.gf)) item.golsFora = headerInfo.gf;
            else if (item.status === "NS") item.golsFora = 0;

            item.golsHTCasa = (headerInfo.htCasa !== null && !isNaN(headerInfo.htCasa)) ? headerInfo.htCasa : null;
            item.golsHTFora = (headerInfo.htFora !== null && !isNaN(headerInfo.htFora)) ? headerInfo.htFora : null;

            // Extração de Destaques (Confronto Direto, Tendências, Mercados) com Filtro Global contra Cantos e Cartões
            const jsonGeral = await page.evaluate((teams) => {
              let dados = { confronto: [], tendencias: [], mercados: [] };
              try {
                const n = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\W/g, '').toLowerCase();
                const nm = n(teams.mandante);
                const nv = n(teams.visitante);

                const ehCantoOuCartao = (texto) => {
                  const lower = (texto || "").toLowerCase();
                  return ["canto", "cantos", "escanteio", "escanteios", "cartao", "cartão", "cartoes", "cartões"].some(k => lower.includes(k));
                };

                // Confronto Direto: cada linha só identifica o time via <img alt="Nome">
                // dentro de .match-insights-icons - alt de img não aparece em innerText,
                // então ler o time daqui (em vez de tentar casar texto solto) é o que
                // realmente evita misturar os dois times num stat só.
                const seenConfronto = new Set();
                document.querySelectorAll('.match-insights-card--h2h .match-insights-row').forEach((row) => {
                  const label = (row.querySelector('.match-insights-label')?.textContent || '').trim();
                  const valor = (row.querySelector('.match-insights-value')?.textContent || '').trim();
                  if (!label || !valor || ehCantoOuCartao(label)) return;

                  let ctx = "Ambos";
                  const alt = (row.querySelector('.match-insights-icons img[alt]')?.getAttribute('alt') || '').trim();
                  if (alt) {
                    const nAlt = n(alt);
                    if (nAlt === nm || nAlt.includes(nm) || nm.includes(nAlt)) ctx = teams.mandante;
                    else if (nAlt === nv || nAlt.includes(nv) || nv.includes(nAlt)) ctx = teams.visitante;
                  }

                  const metrica = ctx !== "Ambos" ? `${ctx} - ${label}` : label;
                  const key = metrica + '|' + valor;
                  if (!seenConfronto.has(key)) {
                    seenConfronto.add(key);
                    dados.confronto.push({ metrica, valor });
                  }
                });

                // Tendências: cada bloco de time (.match-insights-team-block) já vem com
                // o nome do time em texto normal, sem precisar de heurística.
                const seenTendencias = new Set();
                document.querySelectorAll('.match-insights-card--trends .match-insights-team-block').forEach((bloco) => {
                  const nomeTime = (bloco.querySelector('.match-insights-team-name')?.textContent || '').trim();
                  bloco.querySelectorAll('.match-insights-team-row').forEach((row) => {
                    const label = (row.querySelector('.match-insights-team-label')?.textContent || '').trim();
                    const rate = (row.querySelector('.match-insights-team-value')?.textContent || '').trim();
                    if (!label || !rate || ehCantoOuCartao(label)) return;

                    const regra = nomeTime ? `${nomeTime} - ${label}` : label;
                    const key = regra + '|' + rate;
                    if (!seenTendencias.has(key)) {
                      seenTendencias.add(key);
                      dados.tendencias.push({ regra, rate });
                    }
                  });
                });

                // Principais Mercados: o site renderiza um bloco duplicado (desktop +
                // mobile) na mesma página, então sem deduplicar por conteúdo cada
                // mercado aparece 2x na lista.
                const seenMercados = new Set();
                document.querySelectorAll('.odds-market-row, [class*="odds-market-row"]').forEach((row) => {
                  const labelEl = row.querySelector('.odds-market-label, [class*="market-label"]');
                  const oddCells = Array.from(row.querySelectorAll('[class*="odds-market-cell"], [class*="cell"]'));
                  if (labelEl && oddCells.length >= 2) {
                    const nomeStr = (labelEl.innerText || "").trim();
                    const oddsNumeric = oddCells.map((c) => (c.innerText || "").trim()).filter((t) => /^[0-9.]+$/.test(t));
                    if (oddsNumeric.length >= 2) {
                      if (nomeStr === 'Resultado' || nomeStr.includes('0.5 Gols HT') || nomeStr.includes('Over 2.5 Gols')) {
                          const man = oddsNumeric[0], vis = oddsNumeric[oddsNumeric.length - 1];
                          const key = nomeStr + '|' + man + '|' + vis;
                          if (!seenMercados.has(key)) {
                            seenMercados.add(key);
                            dados.mercados.push({ nome: nomeStr, man, vis });
                          }
                      }
                    }
                  }
                });
              } catch (e) {}
              return dados;
            }, { mandante: item.mandante, visitante: item.visitante });

            // --- INÍCIO DO EXTRATOR SNIPER DEFINITIVO ---

            const clicarAba = async (nomeAba: string) => {
              try {
                console.log(`    👉 Clicando na aba: ${nomeAba}`);
                const clicou = await page.evaluate((nome) => {
                    const tabs = Array.from(document.querySelectorAll('.game-tab, button, [role="tab"]'));
                    const target = tabs.find(t => (t.textContent || '').trim().toUpperCase() === nome.toUpperCase());
                    if (target) { (target as HTMLElement).click(); return true; }
                    return false;
                }, nomeAba);

                if (!clicou) {
                    await page.getByText(nomeAba, { exact: true }).first().click({ force: true, timeout: 3000 }).catch(()=>{});
                }
                await page.waitForTimeout(2000);
              } catch (e) {}
            };

            // Extração do H2H ajustada para passar pelas 3 posições exatas [Mandante, H2H, Visitante]
            const extrairH2H = async (modo: 'home' | 'away' | 'h2h', teamName: string) => {
                  await page.evaluate(({ modo, nome }) => {
                      const btns = Array.from(document.querySelectorAll('.pg-cardtab-3-nav .pg-cardtab, .pg-cardtab'));
                      if (modo === 'home' && btns.length >= 1) {
                          (btns[0] as HTMLElement).click();
                      } else if (modo === 'h2h' && btns.length >= 2) {
                          const target = btns.find(b => (b.textContent || '').trim() === 'H2H') || btns[1];
                          (target as HTMLElement).click();
                      } else if (modo === 'away' && btns.length >= 3) {
                          (btns[2] as HTMLElement).click();
                      } else {
                          const target = btns.find(b => (b.textContent || '').includes(nome) || b.innerHTML.includes(nome));
                          if (target) (target as HTMLElement).click();
                      }
                  }, { modo, nome: teamName });
                  
                  await page.waitForTimeout(1500); 

                  return await page.evaluate(() => {
                      const data = [];
                      const seen = new Set();
                      
                      const activePane = document.querySelector('.dsmp-row-ind.active') || document;
                      const rows = activePane.querySelectorAll('a.dsmp-row');

                      rows.forEach(row => {
                          const dt = (row.querySelector('.dsmp-match-local-date')?.textContent || '').trim();
                          
                          const teamEls = row.querySelectorAll('.match-name.match-name-desktop');
                          const mandante = teamEls[0] ? (teamEls[0].textContent || '').trim() : '';
                          const visitante = teamEls[1] ? (teamEls[1].textContent || '').trim() : '';
                          
                          const oddEls = row.querySelectorAll('.dsmp-odd');
                          const odd = oddEls.length > 0 ? (oddEls[oddEls.length - 1].textContent || '').trim() : '-';
                          
                          const placar = (row.querySelector('.dsmp-score-badge')?.textContent || '').trim();

                          const icons = Array.from(row.querySelectorAll('.dsmp-first-goal i, .dsmp-1hf i, .dsmp-2hf i, .dsmp-cs i')).map(iEl => {
                              const cls = iEl.className || '';
                              if (cls.includes('win') || cls.includes('check')) return 'G';
                              if (cls.includes('loss') || cls.includes('close')) return 'R';
                              return 'N';
                          });

                          let [m1, t1, t2, ns] = ['N', 'N', 'N', 'N'];
                          if (icons.length >= 4) { m1 = icons[0]; t1 = icons[1]; t2 = icons[2]; ns = icons[3]; }

                          const key = dt + placar + mandante + visitante;
                          if (dt && placar && !seen.has(key)) {
                              seen.add(key);
                              data.push({ data: dt, mandante, visitante, odd, placar, m1, t1, t2, ns });
                          }
                      });
                      return data;
                  });
            };

            // Extrai as linhas de uma aba (Desempenho/Gols). Quando a aba tem o toggle
            // "Primeiro"/"Segundo", tenta clicar em "Segundo" e capturar de novo, marcando
            // como 'periodo: 2T' SÓ as linhas cujo valor realmente mudou em relação ao
            // "Primeiro" - evita duplicar estatísticas globais (ex.: Aproveitamento da
            // temporada) que usam a mesma classe CSS mas não são por tempo de jogo.
            // O site NÃO troca os dados de Primeiro/Segundo (ou Over/Under, Marcados/
            // Sofridos) por clique - os DOIS blocos já vêm renderizados juntos no DOM
            // (confirmado via debug_raiox.txt: ".pg-tstable-colheader-label" com texto
            // "Primeiro" aparece uma vez, "Segundo" aparece de novo logo depois, cada um
            // com seu próprio conjunto de .pg-tstable-row). O mecanismo antigo de clicar
            // em "Segundo"/"Under Gols"/"Sofridos" e comparar o que mudou resolvia um
            // problema que não existe desse jeito - causava linhas duplicadas (Primeiro
            // ganhava as linhas de Segundo coladas junto) e às vezes clicava no toggle
            // do card errado (Desempenho por Tempo x Gols por Tempo têm botões "Segundo"
            // com o mesmo texto). Agora é uma única passagem pelo DOM que rastreia dois
            // "títulos" em paralelo: o do card (secao) e o do sub-bloco Primeiro/Segundo/
            // Over/Under/Marcados/Sofridos (subRotulo) - sem clicar em nada.
            const extrairLinhasDaTela = async () => {
              return await page.evaluate(() => {
                  const resultados = [];
                  const seen = new Set();

                  // Nenhuma das classes antigas (.pg-card-title etc.) existe de verdade no
                  // site - por isso "secao" sempre saía vazio e as abas caíam no classificador
                  // de fallback por texto, que é frágil e mistura rótulos ambíguos (ex.: "Não
                  // houve mais gols" existe em Quando Marcou E em Quando Sofreu). Os títulos
                  // reais usam .std-line-card-title-text (Aproveitamento, Primeiro Gol, Quando
                  // Marcou/Sofreu Primeiro), .std-tabs-card-title(-desktop) (Desempenho por
                  // Tempo, Total/Gols por Tempo, Gols Marcados e Sofridos) e
                  // .first-goal-flow-section-text (o sub-título "Resultado aos 90 minutos").
                  const SELETOR_TITULO = '.std-line-card-title-text, .std-tabs-card-title, .std-tabs-card-title-desktop, .first-goal-flow-section-text, .pg-card-title, .pg-tstable-title, .pg-card-header, .pg-section-title, h1, h2, h3, h4, h5, h6';
                  const SELETOR_SUBROTULO = '.pg-tstable-colheader-label';
                  const ehTituloPlausivel = (txt) => txt && txt.length > 2 && txt.length < 60;

                  const nodes = Array.from(document.querySelectorAll('.pg-tstable-row, ' + SELETOR_TITULO + ', ' + SELETOR_SUBROTULO));
                  let secaoAtual = '';
                  let subRotuloAtual = '';

                  nodes.forEach(node => {
                      if (node.matches(SELETOR_SUBROTULO)) {
                          const t = (node.textContent || '').trim();
                          if (t) subRotuloAtual = t; // rótulo vazio (colheader só com escudo) não conta
                          return;
                      }
                      if (!node.classList || !node.classList.contains('pg-tstable-row')) {
                          const t = (node.textContent || '').trim().replace(/\s+/g, ' ');
                          if (ehTituloPlausivel(t)) { secaoAtual = t; subRotuloAtual = ''; } // novo card reseta o sub-rótulo
                          return;
                      }

                      const row = node;
                      const label = (row.querySelector('.pg-tstable-label')?.textContent || '').trim();
                      if (!label) return;

                      // O site já calcula se cada valor é bom/ruim/neutro e grava isso na
                      // própria classe do elemento (color-green, color-dark-red, color-neutral
                      // etc.) - lendo direto daqui o app reproduz a MESMA cor do site em vez
                      // de tentar adivinhar se 20% de vitórias é "bom" ou "ruim".
                      const pgcvEls = Array.from(row.querySelectorAll('.pgcv'));
                      const vals = pgcvEls.map(el => (el.textContent || '').trim().replace(/\s+/g, ' '));
                      const cores = pgcvEls.map(el => {
                          const m = (el.className || '').match(/color-[\w-]+/);
                          return m ? m[0] : '';
                      });

                      if (vals.length >= 2) {
                          // A chave inclui seção E sub-rótulo: linhas iguais em cards/sub-blocos
                          // diferentes (Primeiro x Segundo, Over x Under) são dados distintos.
                          const key = secaoAtual + '|' + subRotuloAtual + '|' + label + '|' + vals[0] + '|' + vals[1];
                          if (!seen.has(key)) {
                              seen.add(key);
                              resultados.push({
                                  metrica: label,
                                  secao: secaoAtual,
                                  subRotulo: subRotuloAtual,
                                  casa: vals[0],
                                  fora: vals[1],
                                  media: vals[2] || "",
                                  corCasa: cores[0] || "",
                                  corFora: cores[1] || "",
                                  corMedia: cores[2] || ""
                              });
                          }
                      }
                  });

                  // O Relógio de Gols não é uma tabela só - é 2 ABAS por time
                  // (pg-stat-tab-panel ...-home / ...-away), cada uma com suas 6 janelas
                  // de tempo. Sem saber de qual painel a linha veio, as duas abas ficavam
                  // juntas numa lista só (12 linhas em vez de 6, com valores diferentes -
                  // parecia duplicata, mas eram os dois times misturados).
                  document.querySelectorAll('.pg-goalmomentum-row').forEach(row => {
                      const tempo = (row.querySelector('.pg-gm-time')?.textContent || '').trim();
                      if (!tempo) return;

                      const painel = row.closest('[id*="-home"], [id*="-away"]');
                      const painelId = painel ? painel.id : '';
                      const lado = painelId.includes('-away') ? 'fora' : 'casa';

                      const marcado = (row.querySelector('.pg-gm-marcado')?.textContent || '').trim();
                      const sofrido = (row.querySelector('.pg-gm-sofrido')?.textContent || '').trim();
                      const percM = (row.querySelector('.pg-gm-perc-mercado, [class*="perc-mercado"]')?.textContent || '').trim();
                      const percS = (row.querySelector('.pg-gm-perc-sofrido, [class*="perc-sofrido"]')?.textContent || '').trim();

                      const key = 'relogio' + lado + tempo + marcado + sofrido;
                      if (!seen.has(key)) {
                          seen.add(key);
                          resultados.push({
                              tipo: 'relogio',
                              lado: lado,
                              tempo: tempo,
                              m: percM,
                              s: percS,
                              marcado: marcado,
                              sofrido: sofrido
                          });
                      }
                  });

                  return resultados;
              });
            };

            const extrairTabelaGenerica = async (nomeAba: string) => {
              await clicarAba(nomeAba);
              return await extrairLinhasDaTela();
            };

            let jsonH2H_casa = [];
            let jsonH2H_fora = [];
            let jsonH2H_ambos = [];
            
            try {
              await clicarAba("H2H");
              jsonH2H_casa = await extrairH2H('home', item.mandante);
              jsonH2H_ambos = await extrairH2H('h2h', 'H2H');
              jsonH2H_fora = await extrairH2H('away', item.visitante);

              // A view "H2H" (ambos) parece ter uma tabela bem diferente das views
              // Casa/Fora (que usam .dsmp-row) - ainda não temos o HTML real dela pra
              // confirmar o seletor certo. Em vez de chutar de novo, captura a área ao
              // redor do toggle na primeira vez que vier vazia nesta execução.
              if (jsonH2H_ambos.length === 0 && !jaCapturouDebugH2HAmbos) {
                jaCapturouDebugH2HAmbos = true;
                await page.evaluate(() => {
                  const btns = Array.from(document.querySelectorAll('.pg-cardtab-3-nav .pg-cardtab, .pg-cardtab'));
                  const target = btns.find((b) => (b.textContent || '').trim() === 'H2H') || btns[1];
                  if (target) (target as HTMLElement).click();
                });
                await page.waitForTimeout(1500);
                const htmlH2H = await page.evaluate(() => {
                  const nav = document.querySelector('.pg-cardtab-3-nav');
                  const container = nav ? (nav.closest('[class*="card"]') as HTMLElement || nav.parentElement?.parentElement || nav.parentElement) : document.querySelector('main');
                  return container ? container.outerHTML : (document.body.innerHTML || '').slice(0, 20000);
                });
                fs.writeFileSync('debug_h2h_ambos_vazio.txt', `Jogo: ${item.mandante} x ${item.visitante}\n\n${htmlH2H}`, 'utf8');
                console.log('⚠️ [DEBUG] H2H "ambos" veio vazio - HTML salvo em debug_h2h_ambos_vazio.txt');
              }
            } catch (e) {}

            // ===================== DEBUG DO RAIO-X =====================
            // Salva o HTML real da área de dados pra podermos ler as classes dos
            // títulos de seção em vez de adivinhar seletores.
            if (DEBUG_RAIOX) {
              console.log("\n🔬 [DEBUG_RAIOX] Capturando HTML do Raio-X deste jogo...");
              const partes: string[] = [];

              for (const aba of ["Desempenho", "Gols"]) {
                await clicarAba(aba);
                const dump = await page.evaluate(() => {
                  const linhas = Array.from(document.querySelectorAll('.pg-tstable-row'));
                  if (!linhas.length) {
                    return { erro: "nenhuma .pg-tstable-row encontrada nesta aba", total: 0, html: "" };
                  }
                  // Sobe até o ancestral que contém TODAS as linhas, depois mais 2
                  // níveis pra garantir que os títulos dos cards venham junto.
                  let el: any = linhas[0];
                  while (el.parentElement && !linhas.every(l => el.contains(l))) el = el.parentElement;
                  for (let i = 0; i < 2 && el.parentElement && el.parentElement !== document.body; i++) {
                    el = el.parentElement;
                  }
                  return { erro: null, total: linhas.length, html: el.outerHTML };
                });

                console.log(`   • Aba ${aba}: ${dump.total} linha(s)${dump.erro ? " - " + dump.erro : ""}`);
                partes.push(
                  `\n\n${"=".repeat(80)}\n=== ABA: ${aba} | linhas encontradas: ${dump.total}${dump.erro ? " | ERRO: " + dump.erro : ""}\n${"=".repeat(80)}\n\n${dump.html}`
                );
              }

              const cabecalho = `DEBUG RAIO-X\nJogo: ${item.mandante} x ${item.visitante}\nLiga: ${item.pais} - ${item.competicao}\nURL: ${linkAutenticado}\nGerado em: ${new Date().toISOString()}\n`;
              fs.writeFileSync("debug_raiox.txt", cabecalho + partes.join(""), "utf8");

              console.log("✅ [DEBUG_RAIOX] Arquivo salvo em: debug_raiox.txt");
              console.log("🛑 [DEBUG_RAIOX] Motor interrompido (nada foi gravado no Firestore).");
              console.log("   Envie o arquivo pro Claude e depois volte DEBUG_RAIOX para false.\n");
              return; // o finally fecha o navegador
            }

            const jsonDesempenho = await extrairTabelaGenerica("Desempenho").catch(() => []);
            const jsonGols = await extrairTabelaGenerica("Gols").catch(() => []);

            // --- FIM DO EXTRATOR SNIPER DEFINITIVO ---

            // Regra de Preservação do Horário
            let horaPreservada = item.hora && item.hora !== "" ? item.hora : "00:00";
            try {
              const docExistente = await db.collection("jogos_ao_vivo").doc(String(item.id)).get();
              if (docExistente.exists) {
                const dadosAntigos = docExistente.data();
                if (dadosAntigos && dadosAntigos.hora && dadosAntigos.hora !== "00:00" && dadosAntigos.hora !== "") {
                  horaPreservada = dadosAntigos.hora;
                }
              }
            } catch (e) {}

            const docJogo = {
              id: item.id,
              pais: item.pais,
              competicao: item.competicao,
              mandante: item.mandante,
              visitante: item.visitante,
              logoCasa: item.logoCasa,
              logoFora: item.logoFora,
              oddCasa: item.oddCasa,
              oddEmpate: item.oddEmpate,
              oddFora: item.oddFora,
              status: item.status,
              hora: horaPreservada,
              dataJogo: item.dataJogo,
              golsCasa: item.golsCasa,
              golsFora: item.golsFora,
              golsHTCasa: item.golsHTCasa ?? null,
              golsHTFora: item.golsHTFora ?? null,
              isDestaque: item.isDestaque || false,
              eventosJSON: JSON.stringify({
                principais_json: jsonGeral,
                raiox_json: {
                  aproveitamento: [], 
                  h2h: jsonH2H_ambos,
                  h2h_casa: jsonH2H_casa, 
                  h2h_fora: jsonH2H_fora,
                  desempenho: jsonDesempenho,
                  gols: jsonGols
                }
              }),
              atualizadoEm: new Date().toISOString(),
            };

            await db.collection("jogos_ao_vivo").doc(String(item.id)).set(docJogo, { merge: true });
            console.log(`    └─ Dados sincronizados no Firestore com sucesso!`);
          } catch (error) {
            console.error(`❌ Erro no jogo ${item.mandante} x ${item.visitante}:`, error.message);
          }
        }
    }

    const fimMs = Date.now();
    if (cancelarVarreduraAtual) {
      await atualizarStatusMotor({
        status: "CANCELADO",
        ultimoLog: `Cancelado após ${totalJogosNaRodada} jogos - novo horário agendado assumiu.`,
        mensagem: "Varredura cancelada (novo horário agendado assumiu).",
        duracaoMinutos: Math.floor((fimMs - inicioMs) / 60000),
      });
      console.log(`\n🛑 Varredura interrompida por cancelamento. Total de jogos processados: ${totalJogosNaRodada}.`);
    } else {
      await atualizarStatusMotor({
        status: "CONCLUÍDO",
        ultimoLog: `Processados ${totalJogosNaRodada} jogos. (HOJE, ONTEM e AMANHÃ)`,
        mensagem: "Varredura concluída com sucesso.",
        duracaoMinutos: Math.floor((fimMs - inicioMs) / 60000),
      });
      console.log(`\n✅ Varredura finalizada. Total de jogos HOJE: ${totalJogosNaRodada}.`);
    }
  } catch (globalErr) {
    console.error("❌ ERRO FATAL NO MOTOR:", (globalErr as Error).message);
    await atualizarStatusMotor({ status: "ERRO", mensagem: `Falha: ${(globalErr as Error).message}` });
  } finally {
    if (browser) await browser.close();
    navegadorAtivo = null;
    motorEmExecucao = false;
  }
}

// Testa a API-Sports sob pedido do Cockpit (botão "📡 Testar Conexões").
// Roda AQUI, no motor, e não no navegador, por três motivos:
//   1) a API não libera CORS - o fetch do browser morria em "Falha de Rede";
//   2) a chave deixa de precisar sair do servidor pra isso;
//   3) a requisição passa a ser contabilizada no governador de quota, saindo da
//      reserva - antes era um gasto invisível, fora de qualquer controle.
// A chave digitada chega no pedido (permite testar ANTES de salvar); sem ela,
// cai no que está salvo no Firestore.
async function testarConexoesApis(pedido: any = {}) {
  const configDoc = await db.collection("configuracoes").doc("motor").get();
  const config = configDoc.data() || {};
  const asKey = pedido.asKey || config.apifutebol_key || "a1d3726b4534be5d0d6c091ad598b242";

  const linhas: { texto: string; tipo: string }[] = [];
  const amostra: string[] = [];

  // Passa pelo governador, gastando da reserva
  linhas.push({ texto: "Consultando API-Sports...", tipo: "info" });
  const permissao = await autorizarChamadaApiSports(0, true);
  if (!permissao.ok) {
    linhas.push({ texto: `⏸️ API-Sports não consultada: ${permissao.motivo}`, tipo: "aviso" });
    return { ok: true, linhas, amostra, quota: resumoQuota(permissao.usadas) };
  }

  const quota = await debitarChamadaApiSports();
  try {
    const resAS = await fetch(`https://v3.football.api-sports.io/fixtures?live=all`, {
      headers: { 'x-apisports-key': asKey }
    });
    if (resAS.ok) {
      const jsonAS = await resAS.json();
      const erros = jsonAS.errors;
      const temErro = Array.isArray(erros) ? erros.length > 0 : erros && Object.keys(erros).length > 0;
      if (temErro) {
        const detalhe = JSON.stringify(erros);
        linhas.push({ texto: `❌ API-Sports recusou: ${detalhe}`, tipo: "erro" });
        if (/requests|limit|plan/i.test(detalhe)) await queimarOrcamentoApiSports("limite reportado pela própria API");
      } else {
        const total = jsonAS.response?.length || 0;
        linhas.push({ texto: `✅ API-Sports OK! (${total} ativos)`, tipo: "ok" });
        (jsonAS.response || []).slice(0, 3).forEach((g: any) => {
          amostra.push(`[AS] ${g.teams?.home?.name} x ${g.teams?.away?.name} (${g.fixture?.status?.elapsed ?? "LIVE"}')`);
        });
      }
    } else {
      linhas.push({ texto: `❌ Erro API-Sports: Status ${resAS.status}`, tipo: "erro" });
      if (resAS.status === 429) await queimarOrcamentoApiSports("HTTP 429 (rate limit)");
    }
  } catch (e) {
    linhas.push({ texto: `❌ Falha de rede na API-Sports: ${(e as Error).message}`, tipo: "erro" });
  }

  const qFinal = await lerQuotaApiSports();
  return { ok: true, linhas, amostra, quota: resumoQuota(qFinal.usadas) };
}

let lastTesteApisTs: number | null = null;
async function tratarTesteApis(data: any, ehPrimeiraLeitura: boolean) {
  const pedido = data?.testeApisPedido;
  if (!pedido || !pedido.ts) return;
  if (ehPrimeiraLeitura) { lastTesteApisTs = pedido.ts; return; }
  if (pedido.ts === lastTesteApisTs) return;
  lastTesteApisTs = pedido.ts;

  console.log(`📡 Pedido de teste de conexões recebido do Cockpit.`);
  const resultado = await testarConexoesApis(pedido);
  resultado.linhas.forEach(l => console.log(`   └─ ${l.texto}`));
  await db.collection("configuracoes").doc("motor").set({
    testeApisResultado: { ts: pedido.ts, ...resultado }
  }, { merge: true });
}

// Botão 🔄 dos cards: dispara o MESMO sync completo do ciclo automático. Uma
// requisição atualiza todos os jogos do radar de uma vez, e o débito reposiciona
// o relógio do ritmo adaptativo - o próximo ciclo automático passa a contar
// daqui. Depois do sync, relê o doc do jogo clicado pra devolver o placar dele
// no toast.
let lastPlacarManualTs: number | null = null;
async function tratarPlacarManual(data: any, ehPrimeiraLeitura: boolean) {
  const pedido = data?.placarManualPedido;
  if (!pedido || !pedido.ts) return;
  if (ehPrimeiraLeitura) { lastPlacarManualTs = pedido.ts; return; }
  if (pedido.ts === lastPlacarManualTs) return;
  lastPlacarManualTs = pedido.ts;

  console.log(`🔄 Atualização manual pedida do card: ${pedido.mandante} x ${pedido.visitante}`);
  const sync = await sincronizarAoVivoBackend(true);
  console.log(`   └─ ${sync.mensagem}`);

  let placar: any = {};
  if (sync.ok && pedido.idJogo) {
    try {
      const docJogo = await db.collection("jogos_ao_vivo").doc(String(pedido.idJogo)).get();
      const d = docJogo.data();
      if (d) placar = { golsCasa: d.golsCasa ?? 0, golsFora: d.golsFora ?? 0, minutoAoVivo: d.minutoAoVivo || "" };
    } catch (e) {}
  }

  await db.collection("configuracoes").doc("motor").set({
    placarManualResultado: {
      idJogo: pedido.idJogo, ts: pedido.ts,
      ok: sync.ok, mensagem: sync.mensagem, atualizados: sync.atualizados ?? 0,
      quota: sync.quota || "", ...placar
    }
  }, { merge: true });
}

let lastTriggerTime: number | null = null;
async function tratarDisparoVarredura(data: any, ehPrimeiraLeitura: boolean) {
  if (ehPrimeiraLeitura) {
    lastTriggerTime = data?.forcar_leitura || 0;
    return;
  }
  if (data?.forcar_leitura && data.forcar_leitura !== lastTriggerTime) {
    lastTriggerTime = data.forcar_leitura;
    console.log("🔧 Disparo manual recebido pelo Cockpit!");
    await rodarMotorCompleto(data.theo_token);
  }
}

// =========================================================================
// DESLIGAMENTO REMOTO (botão "Desarmar Motor" do Cockpit)
// =========================================================================
// O navegador não consegue matar um processo da máquina, então usa o mesmo canal
// de sempre: grava `desligar_pedido` no Firestore e o motor se encerra sozinho.
// Resolve o "porta 8080 já está em uso" - dá pra desarmar o motor velho pela tela
// e subir um novo sem caçar PID no PowerShell.
let desligando = false;

async function desligarMotor(motivo: string) {
  if (desligando) return;
  desligando = true;

  console.log("=========================================================");
  console.log(`🛑 DESLIGAMENTO PEDIDO PELO COCKPIT (${motivo})`);
  console.log("=========================================================");

  // Fecha o Chromium primeiro: process.exit() sozinho deixaria o navegador órfão
  // segurando memória (e, no Render, contando pro limite da instância).
  if (navegadorAtivo) {
    try { console.log("   ├─ fechando o navegador da raspagem..."); await navegadorAtivo.close(); }
    catch (e) {}
  }

  try {
    await atualizarStatusMotor({
      status: "DESLIGADO",
      mensagem: `Motor desarmado pelo Cockpit em ${new Date().toLocaleTimeString("pt-BR")}.`,
      heartbeat: 0
    });
  } catch (e) {}

  console.log("   ├─ liberando a porta " + PORTA_MOTOR + "...");
  try { servidor.close(); } catch (e) {}
  console.log("   └─ até logo. Rode `npx tsx motor.ts` pra subir de novo.\n");

  setTimeout(() => process.exit(0), 400);
}

let lastDesligarTs: number | null = null;
async function tratarDesligamento(data: any, ehPrimeiraLeitura: boolean) {
  const ts = data?.desligar_pedido;
  if (!ts) return;
  // Na primeira leitura só memoriza: senão um motor novo leria o pedido antigo e
  // se mataria no arranque, que é exatamente o oposto do que o botão serve.
  //
  // A baliza é SÓ `ehPrimeiraLeitura`. Testar `lastDesligarTs === null` junto
  // parecia inofensivo mas engolia o primeiro clique de verdade: no snapshot
  // inicial o campo ainda não existe, o `if (!ts) return` sai antes de gravar a
  // baliza, e aí o primeiro pedido real chegava com a variável ainda em null -
  // era tratado como baliza em vez de comando.
  if (ehPrimeiraLeitura) { lastDesligarTs = ts; return; }
  if (ts === lastDesligarTs) return;
  lastDesligarTs = ts;
  await desligarMotor("pedido às " + new Date(Number(ts)).toLocaleTimeString("pt-BR"));
}

// =========================================================================
// ESCUTA ÚNICA DO COCKPIT
// =========================================================================
// Antes eram TRÊS setInterval de 3s, cada um fazendo seu próprio .get() no mesmo
// documento: 1 leitura por segundo, ~86 mil leituras/dia - acima do limite free do
// Firestore (50 mil/dia) só de ficar parado esperando. Um onSnapshot recebe as
// mudanças empurradas pelo servidor: custa leitura quando algo muda, não a cada
// tique. De quebra, os botões do Cockpit respondem na hora em vez de esperar até 3s.
let primeiraLeituraCockpit = true;
db.collection("configuracoes").doc("motor").onSnapshot(async (doc) => {
  const data = doc.data() || {};
  const ehPrimeira = primeiraLeituraCockpit;
  primeiraLeituraCockpit = false;

  // Desligamento vem primeiro: se o pedido é pra parar, não faz sentido começar
  // uma varredura no mesmo evento.
  try { await tratarDesligamento(data, ehPrimeira); } catch (e) {}
  if (desligando) return;

  try { await tratarTesteApis(data, ehPrimeira); } catch (e) {}
  try { await tratarPlacarManual(data, ehPrimeira); } catch (e) {}
  try { await tratarDisparoVarredura(data, ehPrimeira); } catch (e) {}
}, (err) => {
  console.error(`⚠️ Escuta do Cockpit caiu: ${err.message}`);
});

// Batimento: prova de vida que o Cockpit lê pra dizer se existe motor no ar.
// Sem isso não dá pra saber, olhando o app, se o clique vai ser atendido por
// alguém ou vai ficar parado na caixa de correio.
setInterval(() => {
  if (desligando) return;
  atualizarStatusMotor({ heartbeat: Date.now(), ambiente: NO_RENDER ? "Render" : "local" });
}, 20000);
atualizarStatusMotor({ heartbeat: Date.now(), ambiente: NO_RENDER ? "Render" : "local" });

// =========================================================================
// AGENDAMENTO AUTOMÁTICO (4x/dia, sem precisar de clique no Cockpit)
// =========================================================================
// Às 06h a raspagem de "hoje" já cobre o dia inteiro desde 00h - jogo que começou de
// madrugada já aparece com resultado real, não só marcado como "hoje". Reforça de
// novo às 16h, 21h e 01h.
const HORARIOS_AGENDADOS = ["06:00", "16:00", "21:00", "01:00"]; // horário de Brasília
const MAX_LOGS_AGENDADOS = 20;
let ultimoSlotAgendadoDisparado: string | null = null;

async function registrarLogAgendado(entrada: any, atualizarExistente: boolean) {
  try {
    const ref = db.collection("configuracoes").doc("motor_status");
    const doc = await ref.get();
    const atual: any[] = (doc.exists && Array.isArray(doc.data()?.logsAgendados)) ? doc.data()!.logsAgendados : [];
    const novaLista = atualizarExistente
      ? atual.map(l => l.id === entrada.id ? entrada : l)
      : [...atual, entrada].slice(-MAX_LOGS_AGENDADOS);
    await ref.set({ logsAgendados: novaLista }, { merge: true });
  } catch (e) {}
}

async function dispararCicloAgendado(horario: string) {
  // Ciclo anterior ainda rodando: cancela e espera esvaziar antes de começar o novo -
  // nunca dois Chromium ao mesmo tempo (reentrância tratada dentro de rodarMotorCompleto).
  if (motorEmExecucao) {
    console.log(`⏹️  Horário agendado (${horario}) bateu com ciclo anterior ainda rodando - cancelando o antigo...`);
    cancelarVarreduraAtual = true;
    const esperaAte = Date.now() + 120000;
    while (motorEmExecucao && Date.now() < esperaAte) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (motorEmExecucao) {
      console.error(`❌ Ciclo anterior não cancelou a tempo - pulando o horário das ${horario} pra não rodar dois juntos.`);
      return;
    }
  }

  const id = Date.now();
  const inicio = Date.now();
  await registrarLogAgendado({ id, horario, data: dataLocalStr(agoraSaoPaulo()), inicio, fim: null, status: "EXECUTANDO", mensagem: "" }, false);

  try {
    await rodarMotorCompleto();
  } finally {
    const statusFinal = await db.collection("configuracoes").doc("motor_status").get().catch(() => null);
    const st = statusFinal?.data();
    await registrarLogAgendado({
      id, horario, data: dataLocalStr(agoraSaoPaulo()), inicio, fim: Date.now(),
      status: st?.status || "ERRO", mensagem: st?.mensagem || ""
    }, true);
  }
}

setInterval(() => {
  const agora = agoraSaoPaulo();
  const hhmm = `${String(agora.getHours()).padStart(2, "0")}:${String(agora.getMinutes()).padStart(2, "0")}`;
  if (!HORARIOS_AGENDADOS.includes(hhmm)) return;
  const slot = `${dataLocalStr(agora)} ${hhmm}`;
  if (slot === ultimoSlotAgendadoDisparado) return;
  ultimoSlotAgendadoDisparado = slot;
  console.log(`⏰ Horário agendado batido: ${hhmm} (Brasília).`);
  dispararCicloAgendado(hhmm).catch(e => console.error(`⚠️ [NÃO FATAL] Ciclo agendado falhou: ${e?.message || e}`));
}, 60000);

// =========================================================================
// GARANTIA DO CHROMIUM
// =========================================================================
// O Render às vezes reaproveita o node_modules em cache e pula o postinstall
// (`playwright install chromium`) quando nenhum arquivo de dependência muda - aí a
// primeira raspagem morre com "Executable doesn't exist" e nenhum jogo é
// processado, sem ninguém perceber até checar o log. Roda aqui, uma vez, depois do
// servidor HTTP já estar escutando (não atrasa o health check do Render): se o
// Chromium já está no caminho certo é rápido/no-op; se sumiu, baixa agora, antes de
// qualquer tentativa de raspagem (inicial, agendada ou manual).
try {
  console.log("🔍 Conferindo instalação do Chromium (Playwright)...");
  execSync("npx playwright install chromium", { stdio: "inherit" });
  console.log("✅ Chromium OK.\n");
} catch (e: any) {
  console.error(`⚠️ [NÃO FATAL] Falha ao garantir o Chromium: ${e?.message || e}`);
  console.error("   A raspagem provavelmente vai falhar até isso ser resolvido manualmente no Render.\n");
}

// =========================================================================
// ARRANQUE
// =========================================================================
console.log("=========================================================");
console.log("⚙️ MOTOR FIRESTORE PRONTO");
console.log(`   • Placares ao vivo (API-Sports) ....... a cada 5 min`);
console.log(`   • Escuta do Cockpit (tempo real) ...... varredura, teste,`);
console.log(`     atualização de placar e desarme ..... chegam na hora`);
console.log(`   • Batimento pro app saber que estou vivo  a cada 20s`);
console.log("=========================================================\n");

// A raspagem com Playwright é a parte pesada (Chromium + Node). Numa instância
// free do Render (512 MB) ela pode morrer por falta de memória e levar o processo
// junto - com MOTOR_SEM_RASPAGEM=1 o motor sobe só com as escutas do Firestore e o
// sync de placares, que é o que realmente precisa rodar 24/7. Sem a variável, o
// comportamento é o de sempre: varre na subida.
if (process.env.MOTOR_SEM_RASPAGEM === "1") {
  console.log("🚫 [CONFIG] MOTOR_SEM_RASPAGEM=1 - varredura inicial desativada.");
  console.log("   As escutas do Cockpit seguem ativas: o botão \"Salvar & Rodar\" ainda dispara a raspagem sob demanda.\n");
} else {
  rodarMotorCompleto().catch(e => {
    console.error(`⚠️ [NÃO FATAL] A varredura inicial falhou: ${e?.message || e}`);
    console.error("   O servidor HTTP e as escutas do Firestore seguem no ar.");
  });
}