param(
  [string]$RepoUrl = "https://github.com/sajadcherif01/geststock-erp.git"
)

Write-Host "Preparation de la publication GestStock..." -ForegroundColor Cyan

if (-not (Test-Path ".git")) {
  git init -b main
}

$remote = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) {
  git remote add origin $RepoUrl
} else {
  git remote set-url origin $RepoUrl
}

git add .
git commit -m "Update GestStock GitHub Pages" 2>$null
git push -u origin main

Write-Host ""
Write-Host "Si le push a reussi, active maintenant GitHub Pages :" -ForegroundColor Green
Write-Host "Settings > Pages > Deploy from a branch > main > /root > Save"
Write-Host "URL prevue : https://sajadcherif01.github.io/geststock-erp/"
