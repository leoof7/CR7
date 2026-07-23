import json
import requests
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

# ==========================================
# CONFIGURAÇÕES DA INTEGRAÇÃO
# ==========================================
# ⚠️ ATENÇÃO: Cole a URL final do Apps Script que termina em /exec
WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwjh8kM3lfDxZyruphIz-3V9yU9kRRd39jMyN1NzP0_a1iZuDENKct5ScasBFT6qTHOqA/exec"

TOKEN = "8f88b4c964"
DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha"]

EXTRACTOR_JS = """
() => {
    let m = "Mandante", v = "Visitante", comp = "Geral", h = "19:00", st = "NS", gc = "-", gf = "-", oc = "", of = "", lc = "", lf = "";

    try {
        // 1. Tenta pegar JSON raiz do NextJS (O Mais Preciso)
        let nextData = document.getElementById('__NEXT_DATA__');
        if (nextData) {
            let d = JSON.parse(nextData.innerText);
            let match = d?.props?.pageProps?.match;
            if (match) {
                if (match.homeTeam?.name) m = match.homeTeam.name;
                if (match.awayTeam?.name) v = match.awayTeam.name;
                if (match.league?.name) comp = match.league.name;
                if (match.homeScore !== null && match.homeScore !== undefined) gc = match.homeScore;
                if (match.awayScore !== null && match.awayScore !== undefined) gf = match.awayScore;
                if (match.status === 'finished') st = "FT";
                else if (match.status === 'in_progress') st = "LIVE";
            }
        }

        // 2. Tenta pegar pelo Titulo da Página se o JSON falhou
        if (m === "Mandante") {
            let title = document.title;
            if (title && title.includes(' vs ')) {
                let parts = title.split(' - ')[0].split(' vs ');
                if (parts.length === 2) { m = parts[0].trim(); v = parts[1].trim(); }
            }
        }

        // 3. Tenta pelas Classes Visuais (Para as Odds e Logos)
        let hImg = document.querySelector('.card-match-teams-block.home img');
        if (hImg) lc = hImg.src;
        let aImg = document.querySelector('.card-match-teams-block.away img');
        if (aImg) lf = aImg.src;

        let hOdd = document.querySelector('.card-match-teams-block.home .card-match-odds-item');
        if (hOdd) oc = hOdd.innerText.trim();
        let aOdd = document.querySelector('.card-match-teams-block.away .card-match-odds-item');
        if (aOdd) of = aOdd.innerText.trim();

        let header = document.querySelector('.card-match-header');
        if (header && comp === "Geral") {
            comp = header.innerText.split('\\n')[0];
        }
        
        let center = document.querySelector('.card-match-center');
        if (center) {
            let tMatch = center.innerText.match(/\\d{2}:\\d{2}/);
            if (tMatch) h = tMatch[0];
        }
        
        // 4. Último Recurso: Busca bruta no texto para as Odds
        if(!oc || !of) {
           let txt = document.body.innerText;
           let oddMatch = txt.match(/Resultado[\\s\\S]*?([\\d\\.]+)[\\s\\S]*?([\\d\\.]+)/i);
           if(oddMatch) { oc = oddMatch[1]; of = oddMatch[2]; }
        }

    } catch(e) { console.log(e); }

    return { mandante: m, visitante: v, competicao: comp, hora: h, status: st, gC: gc, gF: gf, oddC: oc, oddF: of, logoC: lc, logoF: lf, texto: document.body.innerText.substring(0, 8000) };
}
"""

def run_scraper():
    print("🤖 Iniciando Motor Python Playwright (Extrator Blindado e Triplo)...")
    jogos_extraidos = []
    links_visitados = set()
    
    hoje = datetime.now()
    mapa_datas = {
        "ontem": (hoje - timedelta(days=1)).strftime("%Y-%m-%d"),
        "hoje": hoje.strftime("%Y-%m-%d"),
        "amanha": (hoje + timedelta(days=1)).strftime("%Y-%m-%d")
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Camuflagem pesada para evitar bloqueios de segurança
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        page = context.new_page()

        for dia in DIAS_PARA_RASPAR:
            data_oficial = mapa_datas[dia]
            url_lista = f"https://clube.theoborges.com/matches?dia={dia}&t={TOKEN}"
            print(f"\n📍 Lendo lista: {dia.upper()} ({data_oficial})")
            
            try:
                page.goto(url_lista, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)
                
                hrefs = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
                game_links = [href for href in hrefs if "/game/" in href]
                print(f"✅ {len(game_links)} jogos listados.")
                
                for link in game_links:
                    if link in links_visitados: continue
                    links_visitados.add(link)
                    
                    try:
                        print(f"  ⏳ Acessando: {link}")
                        page.goto(link, wait_until="domcontentloaded", timeout=20000)
                        
                        # A MUDANÇA PRINCIPAL: Chega de esperar classes CSS específicas. 
                        # Entra, espera 5 segundos pro Javascript do Theo carregar a tela e ataca!
                        page.wait_for_timeout(5000)
                        
                        dados = page.evaluate(EXTRACTOR_JS)
                        
                        if dados["mandante"] == "Mandante":
                            print(f"  ⚠️ Nomes Vazios (Bloqueio ou Layout diferente): {link}")
                            continue

                        dados["fixtureId"] = link.split("/game/")[1].split("?")[0]
                        dados["dataJogo"] = data_oficial
                        
                        jogos_extraidos.append(dados)
                        print(f"  🎯 SUCESSO: {dados['mandante']} x {dados['visitante']} | Odds: {dados['oddC']} / {dados['oddF']}")
                        
                    except Exception as e:
                        print(f"  ❌ ERRO AO LER: {str(e)[:100]}")

            except Exception as e:
                print(f"⚠️ Erro ao carregar a lista de {dia}.")

        browser.close()

    if jogos_extraidos:
        print(f"\n🚀 Enviando {len(jogos_extraidos)} jogos para a Planilha...")
        try:
            resp = requests.post(WEBHOOK_URL, json={"jogos": jogos_extraidos})
            print(f"Resposta da Planilha: {resp.text}")
        except Exception as e:
            print(f"❌ Erro de Conexão com o Google: {e}")
    else:
        print("\n🤷 Nenhum jogo processado com sucesso.")

if __name__ == "__main__":
    run_scraper()
