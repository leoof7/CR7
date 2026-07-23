import json
import requests
from playwright.sync_api import sync_playwright

# ==========================================
# CONFIGURAÇÕES DA INTEGRAÇÃO
# ==========================================
# ⚠️ ATENÇÃO: Cole a URL final do Apps Script que termina em /exec
WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbztJ0eU-OajlwQKL7VC7qSzpGjQ1375U5exEdNx49c4TAcA-If4NnFI1OryoDaOHR9REw/exec"

# Token de acesso do link do Theo Borges
TOKEN = "8f88b4c964"

# Dias que o robô vai raspar
DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha"]

def run_scraper():
    print("🤖 Iniciando o Robô Scraper CR7 (Modo Tríplice: Ontem, Hoje, Amanhã)...")
    
    # Usamos 'set' para garantir que não mandaremos links duplicados
    todos_os_links = set() 

    with sync_playwright() as p:
        # Abre o navegador em modo invisível
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # O robô vai varrer os 3 dias
        for dia in DIAS_PARA_RASPAR:
            url = f"https://clube.theoborges.com/matches?dia={dia}&t={TOKEN}"
            print(f"🌐 Acessando {dia.upper()}: {url} ...")
            
            try:
                # O segredo: 'networkidle' espera até que o JavaScript do Theo termine de carregar a tela
                page.goto(url, wait_until="networkidle", timeout=15000)
                
                # Procura todas as tags <a> (links) na página
                links_pagina = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
                
                # Filtra apenas os que são links de jogos
                game_links = [link for link in links_pagina if "/game/" in link]
                
                print(f"✅ Encontrados {len(game_links)} jogos para {dia}.")
                
                # Junta com a nossa lista principal
                todos_os_links.update(game_links)
                
            except Exception as e:
                print(f"⚠️ Erro ao processar a página de {dia}: {e}")

        # Fecha o navegador após varrer tudo
        browser.close()
    
    # Converte o set (conjunto) de volta para uma lista comum
    lista_final = list(todos_os_links)
    
    if len(lista_final) > 0:
        print(f"🚀 Disparando o lote total de {len(lista_final)} jogos para o Terminal CR7 (Google Sheets)...")
        
        try:
            # Empacota no formato JSON e envia o POST
            response = requests.post(WEBHOOK_URL, json={"links": lista_final})
            
            if response.status_code == 200:
                print("🎉 SUCESSO ABSOLUTO! Links enviados e processados pela planilha.")
                print(f"Resposta do Apps Script: {response.text}")
            else:
                print(f"❌ Erro no envio HTTP: {response.status_code} - {response.text}")
        except Exception as e:
            print(f"❌ Erro fatal de conexão com o Webhook: {e}")
    else:
        print("🤷 Nenhum jogo encontrado nos 3 dias rastreados. Nada a enviar.")

if __name__ == "__main__":
    run_scraper()
