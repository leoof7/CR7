import json
import requests
from playwright.sync_api import sync_playwright

WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbxvGzw2XATgU9XhctVdhIu_dSNo5tvKd8AElqgMDH-kS04sXY7llNRJam0ZaSQCX2-uRA/exec"
THEO_URL = "https://clube.theoborges.com/matches?dia=hoje"

def run_scraper():
    print("🤖 Iniciando o Robô Scraper...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        print(f"🌐 Acessando {THEO_URL}...")
        page.goto(THEO_URL, wait_until="networkidle")
        
        links = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
        game_links = list(set([link for link in links if "/game/" in link]))
        
        print(f"✅ Encontrados {len(game_links)} jogos para hoje.")
        browser.close()
        
        if len(game_links) > 0:
            print("🚀 Enviando para o Google Sheets (Terminal CR7)...")
            response = requests.post(WEBHOOK_URL, json={"links": game_links})
            if response.status_code == 200:
                print("🎉 Sucesso! Links enviados para a planilha.")
            else:
                print(f"❌ Erro ao enviar: {response.status_code} - {response.text}")

if __name__ == "__main__":
    run_scraper()
