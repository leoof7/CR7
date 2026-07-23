import json
import requests
from playwright.sync_api import sync_playwright

# ==========================================
# CONFIGURAÇÕES DA INTEGRAÇÃO
# ==========================================
# ⚠️ ATENÇÃO: Cole a URL final do Apps Script que termina em /exec
WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyqpbiSNKRhbJ5qdreOU_eV6qjOAh4-boVFPW6XNIMrS7Zejyql13s2RguE_OmLmexgRw/exec"

TOKEN = "8f88b4c964"
DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha"]

# Script de extração cirúrgica (Injetado direto no navegador)
EXTRACTOR_JS = """
() => {
    let m_name = "Mandante", v_name = "Visitante";
    let logoC = "", logoF = "";
    let oddC = "", oddF = "";
    let status = "NS", gC = "-", gF = "-";
    let time_str = "19:00", comp = "Geral";

    // 1. Extração do Mandante (Baseado no seu print)
    let homeImg = document.querySelector('.card-match-teams-block.home img');
    if(homeImg) {
        m_name = homeImg.alt || "Mandante";
        logoC = homeImg.src || "";
    }
    let homeOdd = document.querySelector('.card-match-teams-block.home .card-match-odds-item');
    if(homeOdd) oddC = homeOdd.innerText.trim();

    // 2. Extração do Visitante
    let awayImg = document.querySelector('.card-match-teams-block.away img');
    if(awayImg) {
        v_name = awayImg.alt || "Visitante";
        logoF = awayImg.src || "";
    }
    let awayOdd = document.querySelector('.card-match-teams-block.away .card-match-odds-item');
    if(awayOdd) oddF = awayOdd.innerText.trim();

    // 3. Extração do Centro (Placar e Hora)
    let centerDiv = document.querySelector('.card-match-center');
    if(centerDiv) {
        let text = centerDiv.innerText;
        let scoreMatch = text.match(/(\\d+)\\s*-\\s*(\\d+)/);
        if(scoreMatch) {
            gC = scoreMatch[1];
            gF = scoreMatch[2];
            status = "FT"; // Se tem placar, finalizou
        }
        let timeMatch = text.match(/\\d{2}:\\d{2}/);
        if(timeMatch) time_str = timeMatch[0];
    }
    
    // 4. Competição
    let headerDiv = document.querySelector('.card-match-header');
    if(headerDiv) {
        comp = headerDiv.innerText.replace(/\\n/g, ' ').trim() || "Geral";
    }

    let fullText = document.body.innerText;

    return {
        mandante: m_name,
        visitante: v_name,
        oddC: oddC,
        oddF: oddF,
        logoC: logoC,
        logoF: logoF,
        gC: gC,
        gF: gF,
        status: status,
        hora: time_str,
        competicao: comp,
        texto: fullText.substring(0, 8000)
    };
}
"""

def run_scraper():
    print("🤖 Iniciando Motor Python Playwright (Modo Sniper)...")
    jogos_extraidos = []
    links_visitados = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        for dia in DIAS_PARA_RASPAR:
            url_lista = f"https://clube.theoborges.com/matches?dia={dia}&t={TOKEN}"
            print(f"\\n📍 Lendo lista: {dia.upper()}")
            
            try:
                # Espera os elementos da lista aparecerem
                page.goto(url_lista, wait_until="networkidle", timeout=20000)
                page.wait_for_timeout(2000) # Fôlego extra para o React renderizar
                
                hrefs = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
                game_links = [href for href in hrefs if "/game/" in href]
                
                print(f"✅ {len(game_links)} jogos listados.")
                
                for link in game_links:
                    if link in links_visitados: continue
                    links_visitados.add(link)
                    
                    try:
                        print(f"  ⏳ Lendo: {link}")
                        page.goto(link, wait_until="networkidle", timeout=15000)
                        
                        # Espera a caixa principal do jogo aparecer antes de tentar ler (Blindagem crucial)
                        page.wait_for_selector('.card-match', timeout=5000)
                        
                        # Roda o script cirúrgico que criamos com base no seu print
                        dados = page.evaluate(EXTRACTOR_JS)
                        
                        fixture_id = link.split("/game/")[1].split("?")[0]
                        dados["fixtureId"] = fixture_id
                        
                        # Controle de falha
                        if dados["mandante"] == "Mandante":
                            print(f"  ⚠️ Falhou ao capturar nomes: {link}")
                            continue

                        jogos_extraidos.append(dados)
                        print(f"  🎯 SUCESSO: {dados['mandante']} x {dados['visitante']} | {dados['gC']}x{dados['gF']} | Odds: {dados['oddC']} / {dados['oddF']}")
                        
                    except Exception as e:
                        print(f"  ❌ Timeout ou falha no jogo: {link}")

            except Exception as e:
                print(f"⚠️ Erro ao carregar a lista de {dia}.")

        browser.close()

    if jogos_extraidos:
        print(f"\\n🚀 Enviando payload de {len(jogos_extraidos)} jogos para o Google Sheets...")
        try:
            resp = requests.post(WEBHOOK_URL, json={"jogos": jogos_extraidos})
            print(f"Resposta do Servidor: {resp.text}")
        except Exception as e:
            print(f"❌ Erro de conexão HTTP: {e}")
    else:
        print("\\n🤷 Nenhum jogo processado com sucesso.")

if __name__ == "__main__":
    run_scraper()
