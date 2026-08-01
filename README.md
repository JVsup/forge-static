# Forge static archive

Jednorázový generátor statické zálohy veřejných stránek modů a addonů SPT
Forge. Rozsah, datový model, omezení a roadmapa jsou v [PLAN.md](PLAN.md).

```text
npm install
npm run archive
npm run serve
```

Publikovatelný výstup vzniká v `docs/`. Capture je obnovitelný; po přerušení lze
`npm run capture` spustit znovu a již uložené odpovědi se použijí z cache.

