import json
import requests
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

# ==========================================
# CONFIGURAÇÕES DA INTEGRAÇÃO
# ==========================================
# ⚠️ ATENÇÃO: Cole a URL final do Apps Script que termina em /exec
WEBHOOK_URL = "COLE_AQUI_A_SUA_URL_EXEC"

TOKEN = "8f88b4c964"
DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha"]

EXTRACTOR_JS = """
() => {
    let m_name = "Mandante", v_name = "Visitante";
    let logoC = "", logoF = "";
    let oddC = "", oddF = "";
    let status = "NS", gC = "-", gF = "-";
    let time_str = "19:00", comp = "Geral";

    let homeImg = document.querySelector('.card-match-teams-block.home img');
    if(homeImg) { m_name = homeImg.alt || "Mandante"; logoC = homeImg.src || ""; }
    let homeOdd = document.querySelector('.card-match-teams-block.home .card-match-odds-item');
    if(homeOdd) oddC = homeOdd.innerText.trim();

    let awayImg = document.querySelector('.card-match-teams-block.away img');
    if(awayImg) { v_name = awayImg.alt || "Visitante"; logoF = awayImg.src || ""; }
    let awayOdd = document.querySelector('.card-match-teams-block.away .card-match-odds-item');
    if(awayOdd) oddF = awayOdd.innerText.trim();

    let centerDiv = document.querySelector('.card-match-center');
    if(centerDiv) {
        let text = centerDiv.innerText;
        let scoreMatch = text.match(/(\d+)\s*-\s*(\d+)/);
        if(scoreMatch) { gC = scoreMatch[1]; gF = scoreMatch[2]; status = "FT"; }
        let timeMatch = text.match(/\d{2}:\d{2}/);
        if(timeMatch) time_str = timeMatch[0];
    }
    
    let headerDiv = document.querySelector('.card-match-header');
    if(headerDiv) { comp = headerDiv.innerText.replace(/\n/g, ' ').trim() || "Geral"; }

    let fullText = document.body.innerText;

    return {
        mandante: m_name, visitante: v_name, oddC: oddC, oddF: oddF,
        logoC: logoC, logoF: logoF, gC: gC, gF: gF, status: status,
        hora: time_str, competicao: comp, texto: fullText.substring(0, 8000)
    };
}
"""

def run_scraper():
    print("🤖 Iniciando Motor Python Playwright (Modo Sniper com Data Exata)...")
    jogos_extraidos = []
    links_visitados = set()
    
    # Mapeia as datas exatas
    hoje = datetime.now()
    mapa_datas = {
        "ontem": (hoje - timedelta(days=1)).strftime("%Y-%m-%d"),
        "hoje": hoje.strftime("%Y-%m-%d"),
        "amanha": (hoje + timedelta(days=1)).strftime("%Y-%m-%d")
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        for dia in DIAS_PARA_RASPAR:
            data_oficial = mapa_datas[dia]
            url_lista = f"https://clube.theoborges.com/matches?dia={dia}&t={TOKEN}"
            print(f"\n📍 Lendo lista: {dia.upper()} ({data_oficial})")
            
            try:
                page.goto(url_lista, wait_until="networkidle", timeout=20000)
                page.wait_for_timeout(2000)
                
                hrefs = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
                game_links = [href for href in hrefs if "/game/" in href]
                print(f"✅ {len(game_links)} jogos listados.")
                
                for link in game_links:
                    if link in links_visitados: continue
                    links_visitados.add(link)
                    
                    try:
                        print(f"  ⏳ Lendo: {link}")
                        page.goto(link, wait_until="networkidle", timeout=15000)
                        page.wait_for_selector('.card-match', timeout=5000)
                        
                        dados = page.evaluate(EXTRACTOR_JS)
                        
                        if dados["mandante"] == "Mandante":
                            print(f"  ⚠️ Falhou ao capturar nomes: {link}")
                            continue

                        # Adiciona a ID e a Data Exata no pacote
                        dados["fixtureId"] = link.split("/game/")[1].split("?")[0]
                        dados["dataJogo"] = data_oficial
                        
                        jogos_extraidos.append(dados)
                        print(f"  🎯 SUCESSO: {dados['mandante']} x {dados['visitante']}")
                        
                    except Exception as e:
                        print(f"  ❌ Timeout ou falha no jogo: {link}")

            except Exception as e:
                print(f"⚠️ Erro ao carregar a lista de {dia}.")

        browser.close()

    if jogos_extraidos:
        print(f"\n🚀 Enviando {len(jogos_extraidos)} jogos para o Google Sheets...")
        try:
            resp = requests.post(WEBHOOK_URL, json={"jogos": jogos_extraidos})
            print(f"Resposta: {resp.text}")
        except Exception as e:
            print(f"❌ Erro HTTP: {e}")
    else:
        print("\n🤷 Nenhum jogo processado com sucesso.")

if __name__ == "__main__":
    run_scraper()
