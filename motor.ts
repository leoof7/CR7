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
// SERVIDOR WEB
// =========================================================================
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("CR7 SIUUU Terminal Engine Online! 🚀");
  })
  .listen(8080, () => {
    console.log("=========================================================");
    console.log("🌐 SERVIDOR WEB ATIVO NA PORTA 8080");
    console.log("⚙️ O Motor está ligado (varre HOJE, ONTEM e AMANHÃ)");
    console.log("=========================================================\n");
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

async function sincronizarAoVivoBackend() {
  try {
    const configDoc = await db.collection("configuracoes").doc("motor").get();
    const config = configDoc.data() || {};
    const smToken = config.sportmonks_token || "RaCnlPpnktbtlbuzsNd51VDXKnCcyZ4QRgtYlOFG4Av91CcQMNrTf4egKM9D";
    const asKey = config.apifutebol_key || "e131aa61be7308e97441e475374f47f1";

    const snapshotJogos = await db.collection("jogos_ao_vivo").get();
    if (snapshotJogos.empty) return;

    let jogosAtuais = [];
    snapshotJogos.forEach(doc => jogosAtuais.push(doc.data()));

    let sucessoSM = false;

    // PLANO A: Sportmonks
    if (smToken) {
      try {
        const resSM = await fetch(`https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${smToken}&include=scores,state,events`);
        if (resSM.ok) {
          const jsonSM = await resSM.json();
          console.log(`🟢 [API LIVE] Sportmonks OK! Retornou ${jsonSM.data?.length || 0} jogos ativos.`);
          
          if (jsonSM.data && Array.isArray(jsonSM.data)) {
            sucessoSM = true;
            for (const item of jsonSM.data) {
              const homeParticipant = item.participants?.find((p: any) => p.meta?.location === 'home');
              const awayParticipant = item.participants?.find((p: any) => p.meta?.location === 'away');
              const homeName = normalizarNome(homeParticipant?.name);
              const awayName = normalizarNome(awayParticipant?.name);

              // BUG CORRIGIDO: os dois placares liam o MESMO .find() sem filtrar por
              // time - golsFora sempre saía igual a golsCasa. Junta pelo participant_id
              // (o mesmo id usado nos eventos abaixo) em vez de confiar num campo de
              // texto solto que pode não existir na resposta.
              const scoresAtuais = (item.scores || []).filter((s: any) => s.description === 'CURRENT');
              const hScore = scoresAtuais.find((s: any) => s.participant_id === homeParticipant?.id)?.score?.goals ?? 0;
              const aScore = scoresAtuais.find((s: any) => s.participant_id === awayParticipant?.id)?.score?.goals ?? 0;
              const min = item.state?.minute || "LIVE";

              // Um único fetch já trouxe os eventos (include=events) - aproveita tudo
              // pra não gastar outra requisição: gols, cartões vermelhos e substituições.
              const eventos = Array.isArray(item.events) ? item.events : [];
              const golsEvt = eventos.filter((e: any) => [14, 15, 16].includes(e.type_id));
              const vermelhosEvt = eventos.filter((e: any) => [20, 21].includes(e.type_id));
              const subsEvt = eventos.filter((e: any) => e.type_id === 18);

              // Lista completa de quem marcou (não só o último) - com time, minuto e
              // tempo (1T/2T, derivado do minuto) pra alimentar a aba "Quem Fez o Gol"
              // E pra validar green/red dos métodos HT/2T mesmo quando o placar de
              // intervalo raspado do site (golsHTCasa/Fora) não estiver disponível.
              const golsDetalhados = golsEvt.map((e: any) => ({
                jogador: e.player_name || "Desconhecido",
                time: e.participant_id === homeParticipant?.id ? 'casa' : 'fora',
                minuto: e.minute ?? null,
                tempo: (e.minute !== null && e.minute !== undefined && e.minute <= 45) ? '1T' : '2T'
              }));
              const lastGoalScorer = golsEvt.length ? (golsEvt[golsEvt.length - 1].player_name || "") : "";
              const vermelhoCasa = vermelhosEvt.filter((e: any) => e.participant_id === homeParticipant?.id).length;
              const vermelhoFora = vermelhosEvt.length - vermelhoCasa;
              const ultimoVermelho = vermelhosEvt.length ? (vermelhosEvt[vermelhosEvt.length - 1].player_name || "") : "";
              const ultimaSubstituicao = subsEvt.length ? (subsEvt[subsEvt.length - 1].player_name || "") : "";

              const match = jogosAtuais.find(j => {
                const m = normalizarNome(j.mandante);
                const v = normalizarNome(j.visitante);
                return (m.includes(homeName) || homeName.includes(m)) && (v.includes(awayName) || awayName.includes(v));
              });

              if (match) {
                await db.collection('jogos_ao_vivo').doc(String(match.id)).set({
                  golsCasa: hScore, golsFora: aScore, status: 'LIVE', minutoAoVivo: `${min}'`,
                  ultimoGol: lastGoalScorer, golsDetalhados: golsDetalhados,
                  cartaoVermelhoCasa: vermelhoCasa, cartaoVermelhoFora: vermelhoFora, ultimoCartaoVermelho: ultimoVermelho,
                  totalSubstituicoes: subsEvt.length, ultimaSubstituicao: ultimaSubstituicao,
                  eventosAoVivoAtualizadoEm: new Date().toISOString()
                }, { merge: true });
              }
            }
            await atualizarStatusMotor({ statusApiLive: `🟢 Sportmonks OK (Última: ${new Date().toLocaleTimeString()})` });
          }
        } else {
          console.log(`🔴 [API LIVE] Erro na Sportmonks. Status: ${resSM.status}`);
        }
      } catch (e) {
        console.log(`🔴 [API LIVE] Falha na rede Sportmonks: ${e.message}`);
      }
    }

    // PLANO B: API-Sports (Se a Sportmonks falhar)
    if (!sucessoSM && asKey) {
      try {
        const resAS = await fetch(`https://v3.football.api-sports.io/fixtures?live=all`, { 
            headers: { 'x-apisports-key': asKey }
        });
        
        if (resAS.ok) {
          const jsonAS = await resAS.json();
          console.log(`🟢 [API LIVE] API-Sports OK! Retornou ${jsonAS.response?.length || 0} jogos ativos.`);
          
          if (jsonAS.response && Array.isArray(jsonAS.response)) {
            for (const item of jsonAS.response) {
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

              const match = jogosAtuais.find(j => {
                const m = normalizarNome(j.mandante);
                const v = normalizarNome(j.visitante);
                return (m.includes(hName) || hName.includes(m)) && (v.includes(aName) || aName.includes(v));
              });

              if (match) {
                await db.collection('jogos_ao_vivo').doc(String(match.id)).set({
                  golsCasa: hScore, golsFora: aScore, status: 'LIVE', minutoAoVivo: `${min}'`,
                  ultimoGol: lastGoalScorer, golsDetalhados: golsDetalhados,
                  cartaoVermelhoCasa: vermelhoCasa, cartaoVermelhoFora: vermelhoFora, ultimoCartaoVermelho: ultimoVermelho,
                  totalSubstituicoes: subsEvt.length, ultimaSubstituicao: ultimaSubstituicao,
                  eventosAoVivoAtualizadoEm: new Date().toISOString()
                }, { merge: true });
              }
            }
            await atualizarStatusMotor({ statusApiLive: `🟢 API-Sports OK (Última: ${new Date().toLocaleTimeString()})` });
          }
        } else {
          console.log(`🔴 [API LIVE] Erro na API-Sports. Status: ${resAS.status}`);
        }
      } catch (e) {
        console.log(`🔴 [API LIVE] Falha na rede API-Sports: ${e.message}`);
      }
    }
  } catch (err) {
    console.log("Erro no sync live", err);
  }
}

// Otimizado para rodar a cada 5 minutos (300.000 ms)
setInterval(sincronizarAoVivoBackend, 300000);

async function rodarMotorCompleto(theoTokenManual: string | null = null) {
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

        const listaEstruturada = resultadoGrade.jogos;
        totalJogosNaRodada += listaEstruturada.length;
        console.log(`📌 [MAPA DO DIA ${diaAlvo.toUpperCase()}]: Encontradas ${listaEstruturada.length} partidas`);

        if (resultadoGrade.descartados.length > 0) {
          const corpoDebug = resultadoGrade.descartados.map((d, i) =>
            `\n${"=".repeat(80)}\n#${i + 1} matchId=${d.matchId} mandanteAchado="${d.mandanteAchado}" visitanteAchado="${d.visitanteAchado}"\n${"=".repeat(80)}\n${d.html}`
          ).join("\n");
          fs.writeFileSync(`debug_jogos_sem_nome_${diaAlvo}.txt`, corpoDebug, "utf8");
          console.log(`⚠️ [DEBUG] ${resultadoGrade.descartados.length} partida(s) sem nome de time - HTML salvo em debug_jogos_sem_nome_${diaAlvo}.txt`);
        }

        let count = 0;
        for (const item of listaEstruturada) {
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
    await atualizarStatusMotor({
      status: "CONCLUÍDO",
      ultimoLog: `Processados ${totalJogosNaRodada} jogos. (HOJE, ONTEM e AMANHÃ)`,
      mensagem: "Varredura concluída com sucesso.",
      duracaoMinutos: Math.floor((fimMs - inicioMs) / 60000),
    });
    console.log(`\n✅ Varredura finalizada. Total de jogos HOJE: ${totalJogosNaRodada}.`);
  } catch (globalErr) {
    console.error("❌ ERRO FATAL NO MOTOR:", (globalErr as Error).message);
    await atualizarStatusMotor({ status: "ERRO", mensagem: `Falha: ${(globalErr as Error).message}` });
  } finally {
    if (browser) await browser.close();
  }
}

// Busca o placar de UM jogo específico na Sportmonks, sob pedido do navegador
// (botão 🛰️ nos cards LIVE/FT). O navegador não pode chamar a Sportmonks direto
// (CORS bloqueia) - só o servidor consegue, por isso o pedido chega até aqui via
// Firestore em vez de fetch() no browser. Mesma lógica de matching (normalizarNome
// + includes nos dois sentidos) e mesmo shape de resposta (scores/participants)
// já comprovados no PLANO A de sincronizarAoVivoBackend.
async function buscarPlacarManualSportmonks(idJogo: string, mandante: string, visitante: string) {
  const configDoc = await db.collection("configuracoes").doc("motor").get();
  const config = configDoc.data() || {};
  const smToken = config.sportmonks_token || "RaCnlPpnktbtlbuzsNd51VDXKnCcyZ4QRgtYlOFG4Av91CcQMNrTf4egKM9D";

  const nomeM = normalizarNome(mandante);
  const nomeV = normalizarNome(visitante);

  const acharEExtrair = (lista: any[]) => {
    const item = (lista || []).find((it: any) => {
      const home = it.participants?.find((p: any) => p.meta?.location === "home");
      const away = it.participants?.find((p: any) => p.meta?.location === "away");
      const h = normalizarNome(home?.name);
      const v = normalizarNome(away?.name);
      return h && v && (nomeM.includes(h) || h.includes(nomeM)) && (nomeV.includes(v) || v.includes(nomeV));
    });
    if (!item) return null;
    const home = item.participants?.find((p: any) => p.meta?.location === "home");
    const away = item.participants?.find((p: any) => p.meta?.location === "away");
    const scoresAtuais = (item.scores || []).filter((s: any) => s.description === "CURRENT");
    return {
      golsCasa: scoresAtuais.find((s: any) => s.participant_id === home?.id)?.score?.goals ?? 0,
      golsFora: scoresAtuais.find((s: any) => s.participant_id === away?.id)?.score?.goals ?? 0,
      minuto: item.state?.minute
    };
  };

  try {
    const resLive = await fetch(`https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${smToken}&include=scores,state,participants`);
    if (resLive.ok) {
      const jsonLive = await resLive.json();
      const achado = acharEExtrair(jsonLive.data);
      if (achado) {
        await db.collection("jogos_ao_vivo").doc(String(idJogo)).set({
          golsCasa: achado.golsCasa, golsFora: achado.golsFora, status: "LIVE",
          ...(achado.minuto ? { minutoAoVivo: `${achado.minuto}'` } : {}),
          eventosAoVivoAtualizadoEm: new Date().toISOString()
        }, { merge: true });
        return { ok: true, golsCasa: achado.golsCasa, golsFora: achado.golsFora, origem: "ao vivo" };
      }
    } else {
      return { ok: false, mensagem: `Sportmonks respondeu ${resLive.status} - confira o token na Sala de Máquinas.` };
    }

    // Não achou entre os ao vivo - tenta os resultados recentes (pode ter acabado
    // de terminar). Não mexe no status aqui, só corrige o placar - quem decide FT
    // continua sendo o relógio/raspagem, igual já funciona hoje.
    const resLatest = await fetch(`https://api.sportmonks.com/v3/football/livescores/latest?api_token=${smToken}&include=scores,state,participants`);
    const achadoLatest = resLatest.ok ? acharEExtrair((await resLatest.json()).data) : null;
    if (achadoLatest) {
      await db.collection("jogos_ao_vivo").doc(String(idJogo)).set({
        golsCasa: achadoLatest.golsCasa, golsFora: achadoLatest.golsFora,
        eventosAoVivoAtualizadoEm: new Date().toISOString()
      }, { merge: true });
      return { ok: true, golsCasa: achadoLatest.golsCasa, golsFora: achadoLatest.golsFora, origem: "recente" };
    }

    return { ok: false, mensagem: `"${mandante} x ${visitante}" não encontrado no Sportmonks agora (nem ao vivo, nem recém-encerrado).` };
  } catch (e) {
    return { ok: false, mensagem: `Erro ao consultar Sportmonks: ${(e as Error).message}` };
  }
}

let lastPlacarManualTs: number | null = null;
setInterval(async () => {
  try {
    const doc = await db.collection("configuracoes").doc("motor").get();
    const pedido = doc.data()?.placarManualPedido;
    if (!pedido || !pedido.ts) return;
    if (lastPlacarManualTs === null) { lastPlacarManualTs = pedido.ts; return; }
    if (pedido.ts === lastPlacarManualTs) return;
    lastPlacarManualTs = pedido.ts;

    console.log(`🛰️ Pedido manual de placar: ${pedido.mandante} x ${pedido.visitante}`);
    const resultado = await buscarPlacarManualSportmonks(pedido.idJogo, pedido.mandante, pedido.visitante);
    console.log(resultado.ok ? `   └─ Achado (${resultado.origem}): ${resultado.golsCasa}-${resultado.golsFora}` : `   └─ ${resultado.mensagem}`);
    await db.collection("configuracoes").doc("motor").set({
      placarManualResultado: { idJogo: pedido.idJogo, ts: pedido.ts, ...resultado }
    }, { merge: true });
  } catch (e) {}
}, 3000);

let lastTriggerTime: number | null = null;
setInterval(async () => {
  try {
    const doc = await db.collection("configuracoes").doc("motor").get();
    if (doc.exists) {
      const data = doc.data();
      if (lastTriggerTime === null) {
        lastTriggerTime = data?.forcar_leitura || 0;
        return;
      }
      if (data?.forcar_leitura && data.forcar_leitura !== lastTriggerTime) {
        lastTriggerTime = data.forcar_leitura;
        console.log("🔧 Disparo manual recebido pelo Cockpit!");
        await rodarMotorCompleto(data.theo_token);
      }
    }
  } catch (e) {}
}, 3000);

rodarMotorCompleto();