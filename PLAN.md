# Jednorázová statická záloha Forge

## Cíl

Vytvořit neměnnou, lehkou a plně proklikávatelnou statickou zálohu veřejných
stránek modů a addonů z `forge.sp-tarkov.com`. Výchozí množinu tvoří všechny
mody kompatibilní s SPT `>=4.0.0`; archivace se následně rekurzivně rozšíří o
každý mod či addon nalezený v závislostech nebo interních odkazech.

Výsledek bude uložen v `docs/` a publikovatelný přímo přes GitHub Pages pod
`https://jvsup.github.io/forge-static/`. Web nebude potřebovat server, databázi,
build na GitHubu ani síťové požadavky na Forge.

## Rozsah zachycených dat

- Úplné API detaily modů a addonů, všechny historické verze, závislosti,
  kompatibilita SPT/Fika, metadata, licence, source odkazy a VirusTotal odkazy.
- Veřejné HTML detailů se použije jako doplňkový zdroj pro údaje, které API
  neposkytuje (role autorů, modlist count a viditelnost záložek).
- Popisy, poznámky verzí a disclosure texty se sanitizují a jejich interní Forge
  odkazy se přepíší na lokální stránky.
- Thumbnail, avatary, favicon a všechny vložené obrázky se stáhnou, deduplikují
  podle SHA-256 a optimalizují. SVG se zachová, rastrové obrázky se podle potřeby
  převedou do WebP.
- ZIP/7z soubory modů, komentáře, File Verification panely a jejich file trees se
  nezálohují.
- Externí videa, zdrojové repozitáře, VirusTotal a externí soubory zůstanou
  odkazy; jejich obsah nebude součástí archivu.

## Datový tok

1. `npm run capture` stránkuje API `/api/v0/mods` s filtrem
   `filter[spt_version]=>=4.0.0` a `per_page=50`.
2. Fronta zpracuje každý mod, jeho úplné verze, addony a veřejnou HTML stránku.
3. Z popisů, poznámek verzí, disclosures, závislostí a addon vazeb se získají
   další Forge mod/addon ID. Fronta pokračuje až do uzavření grafu.
4. API klient omezuje provoz na 2 požadavky za sekundu, respektuje `Retry-After`,
   exponenciálně opakuje dočasné chyby a každý výsledek ukládá do obnovitelné
   cache.
5. Download URL se pouze rozbalí přes redirecty. Cíl mimo Forge se uloží přímo;
   Forge cíl nebo chyba dostane text `nuked from forge, try source code url`.
6. Asset pipeline stáhne obrázky, ověří MIME, spočítá SHA-256 a uloží jedinou
   kopii každého obsahu.
7. `npm run build` vytvoří `docs/` z normalizovaného snapshotu a šablon.
8. `npm run verify` ověří graf, lokální odkazy, assety, zakázané Forge URL,
   downloady a limity GitHub Pages.

## Struktura projektu

- `src/` — capture, build, image pipeline, lokální server a validátor.
- `templates/` — Nunjucks šablony indexů a detailů.
- `static/` — vlastní CSS, JavaScript, favicon a statické vizuální prvky.
- `snapshot/cache/` — obnovitelné odpovědi API/HTML a stav fronty.
- `snapshot/data/` — normalizované JSON záznamy a manifest.
- `snapshot/assets/` — deduplikované lokální obrázky použité při buildu.
- `docs/` — jediný publikovaný web včetně `.nojekyll`.

## Výsledné stránky

- `/` a `/mods/` zobrazí všechny archivované mody najednou bez stránkování;
  domovská stránka navíc obsahuje sekci addonů.
- `/addons/` je úplný addon index.
- `/mod/<id>/<slug>/` má Description, Versions a případně Addons.
- `/addon/<id>/<slug>/` má Description a Versions.
- Všechny karty jsou přímo v HTML a obrázky používají `loading="lazy"`.
- Malý lokální JavaScript poskytne hledání, řazení, filtry a přístupné hash taby.
- Odkazy jsou relativní, takže fungují na GitHub Pages, lokálním HTTP serveru i
  ve stažené kopii.
- Každá stránka obsahuje datum snapshotu a viditelné upozornění na neoficiální
  archiv bez vztahu k původnímu Forge.

## Vizuální a přístupnostní pravidla

- Vlastní tmavé cyan/gray rozvržení zachová informační hierarchii Forge bez
  převzetí Livewire nebo jiného runtime frameworku.
- Ovládací prvky mají viditelný focus, popisky a dostatečný kontrast.
- Taby fungují myší, dotykem, Enter/Space i šipkami a aktualizují
  `aria-selected` a URL hash.
- Rozvržení se kontroluje na šířkách 375, 768 a 1440 px.
- Data se zobrazují absolutně, nikoli relativním textem typu „Yesterday“.

## Obrázky a velikost

První průchod používá maximálně 512 px pro thumbnails, 256 px pro avatary a
1920 px pro obsahové obrázky; WebP kvalitu 82 použije jen při menším výsledku.
Animace se zachovají. Pokud `docs/` přesáhne 900 MiB, build opakuje optimalizaci
v profilech 1600/q72, 1280/q60 a 1024/q45. Žádný soubor nesmí překročit 100 MB.
Prioritou je fungování na GitHub Pages před zachováním originálních obrazových
bytů, ale každý zdrojový obrázek musí zůstat vizuálně reprezentovaný.

## Download odkazy

- Archivy modů se nestahují.
- Externí finální URL se použije přímo.
- Pokud redirect zůstane na `forge.sp-tarkov.com` nebo
  `forge-static.sp-tarkov.com`, selže či ho nelze určit, místo tlačítka se
  zobrazí přesně `nuked from forge, try source code url`.
- Existuje-li source URL, slova `source code url` odkazují na první zdroj; všechny
  source URL současně zůstanou v Details.
- V publikovaném webu nesmí zůstat aktivní Forge URL v `href`, `src`, `srcset`,
  formulářích ani skriptech.

## Ověření a akceptace

- Seed manifest obsahuje všechny živé výsledky filtru, nikoli natvrdo 690.
- Každý interně odkazovaný mod/addon má lokální stránku a indexovou kartu.
- Každý mod má Description a Versions, addon Description a Versions; Addons tab
  se zobrazí tam, kde existují navázané addony.
- Neexistuje Comments tab, File Verification panel, login, reportování,
  analytika, cookies ani požadavky na Forge.
- Všechny interní odkazy a lokální obrázky existují; každý obrázek má alt text a
  platný MIME typ.
- Každý download je přímá ne-Forge URL nebo přesný fallback text.
- Indexové filtrování pracuje nad všemi kartami bez stránkování.
- Web funguje pod projektovým subpath, `docs/` je pod 900 MiB a jednotlivé
  soubory pod 100 MB.
- Souhrn validace vypíše počet modů, addonů, verzí, obrázků, externích downloadů,
  fallbacků a rozbitých interních odkazů.

## Roadmapa a commity

1. Nastavit `origin`, přejmenovat větev na `main`, uložit plán a skeleton;
   commit `Add archive plan and generator scaffold`.
2. Implementovat obnovitelnou capture pipeline; commit
   `Add Forge archive capture pipeline`.
3. Spustit úplný rekurzivní snapshot a zkontrolovat manifest.
4. Implementovat šablony, vizuál, lokální navigaci a image pipeline.
5. Vygenerovat `docs/`, spustit automatické a vizuální kontroly.
6. Commitnout snapshot a web v logických dávkách a pushnout `main`.
7. Zapnout GitHub Pages z `main` / `docs` a ověřit veřejnou URL.

## Omezení

- Jde o jediný neměnný snapshot, ne o aktualizační službu.
- Externí odkazy mohou později zaniknout; záloha uchovává jejich snapshotovou
  URL, nikoli externí obsah.
- Rekurzivně objevené položky nemají zvláštní režim a dostanou plný detail.
- Pokud veřejná stránka během capture zmizí, po retry se vytvoří standardní
  stránka z posledních API dat a manifest jasně uvede stav chyby.
- Publikace jde přímo do `main`, bez pull requestu, protože repozitář je určen
  výhradně pro tento archiv.

