@echo off
color 0A
echo ==================================================
echo       INICIANDO BACKUP DO CR7 PARA O GITHUB
echo ==================================================
echo.

:: Garante que o script va para a pasta certa do seu projeto
cd C:\Users\leandro.felisberto\Documents\CR

echo [1/3] Adicionando arquivos novos e modificados na fila...
git add .
echo.

:: Pede a mensagem do commit
set /p msg="Digite o que voce alterou (ou aperte Enter para padrao): "
if "%msg%"=="" set msg="Atualizacao automatica via script BAT"

echo.
echo [2/3] Carimbando o pacote com a sua mensagem...
git commit -m "%msg%"
echo.

echo [3/3] Empurrando para a nuvem...
git push origin main
echo.

echo ==================================================
echo         PROJETO SALVO NO GITHUB COM SUCESSO!
echo ==================================================
pause