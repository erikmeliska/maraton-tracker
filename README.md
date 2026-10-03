# Kde je bežec – MMM Košice

Webová appka (PWA) pre divákov **Medzinárodného maratónu mieru v Košiciach**: ukazuje na mape, kde sa
práve nachádza sledovaný bežec – podľa štartu, tempa a reálnych medzičasov z čipovej časomiery.
Pohľad bežca cez Google Street View, 3D mapa s budovami, sledovanie viacerých bežcov naraz a lídri
jednotlivých disciplín.

Naživo: **https://maraton.ixy.sk** (napr. `?bib=10664`)

## Čo vie

- **Predikcia polohy** – od štartu (vlny podľa štartového čísla, potom reálny štart z čipu) a tempa
  z posledného úseku medzi dvoma známymi bodmi; pred prvým bodom plánované tempo.
- **Medzičasy z čipu** – zo súboru Wiclax `.clax` na championchip.cz, ako záloha z oficiálnej appky
  MYLAPS TRACX.
- **Upresnenie divákmi** – ktokoľvek na trati ťukne na mapu a zadá čas prechodu; zdieľa sa so
  všetkými, čo sledujú to isté číslo. Overuje sa GPS (do 1 km od miesta) a čas (max. 15 min dozadu).
- **Disciplíny** – polmaratón (1 okruh), maratón a štafeta (2 okruhy), inline, handbike; zisťujú sa
  podľa čísla z oficiálnej registrácie (TRACX), v deň pretekov z čipu.
- **Viac bežcov naraz** – lišta sledovaných, prepínanie kamery, režim „⤢ Všetci“.
- **Lídri** – prví v každej disciplíne (celkovo / muži / ženy) podľa posledného merania; pred prvým
  meraním favoriti.
- **Pohľad bežca** (Street View otočený v smere behu) a **3D kamera** za bežcom.
- **Simulácia** – vlastná (lokálna) alebo spoločná od správcu, ku ktorej sa ostatní pripoja.
- **PWA** – dá sa pridať na plochu, funguje aj pri slabom signáli.

## Architektúra

```
index.html            celá appka (vanilla JS, bez buildu) – mapa, predikcia, UI
route.json            trasa jedného okruhu (z oficiálnej Google My Maps, route.kml)
sw.js, manifest…      PWA
api/server.js         Node 24, bez závislostí – zdieľané prechody, čip, TRACX, lídri
devserver.py          lokálny server (statika + proxy /api a /clax)
deploy.sh             nasadenie (vloží API kľúč, scp na server)
make_icons.py         ikony z tvaru trasy
```

Server drží stav v `api/data/state.json`, súbor z čipu sťahuje raz za minútu pre všetkých
a divákom posiela len pár kB pre konkrétne číslo.

### API

| Endpoint | |
|---|---|
| `GET /api/runner/:bib` | prechody, čip, TRACX, disciplína a meno, simulácia |
| `POST /api/runner/:bib/cp` | nový prechod (`d`, `t`, `lat`, `lng`, `acc`) |
| `DELETE /api/runner/:bib/cp/:id` | zmazanie (autor alebo správca) |
| `PUT /api/runner/:bib` | plánované tempo (správca) |
| `PUT/DELETE /api/runner/:bib/sim` | spoločná simulácia (správca) |
| `GET /api/leaders` | lídri / favoriti všetkých disciplín |
| `GET/PUT /api/config` | odkaz na súbor z čipu (správca) |
| `POST /api/login` | heslo správcu → token |

## Spustenie lokálne

```bash
echo "TVOJ_GOOGLE_MAPS_KEY" > .apikey
cd api && ADMIN_TOKEN=test ADMIN_PASSWORD=1234 node server.js &
cd .. && python3 devserver.py 8765
```

Potom `http://localhost:8765/?bib=10664&simkm=5&speed=10`.

Google Maps kľúč potrebuje **Maps JavaScript API**, billing a obmedzenie na tvoje domény;
3D mapa používa vektorové Map ID (`CFG.mapId` v `index.html`).

## Nasadenie

Statika ide na server cez `deploy.sh`, API beží v Dockeri (`node:24-slim`) za Caddy:

```
maraton.example {
    encode zstd gzip
    handle /api/* { reverse_proxy maraton-api:8080 }
    handle { root * /srv/maraton; file_server }
}
```

Premenné API: `ADMIN_TOKEN`, `ADMIN_PASSWORD`, `PORT`.

## Zdroje dát

- Trasa: oficiálna mapa trate MMM 2026 (kosicemarathon.com).
- Časomiera: [championchip.cz](https://championchip.cz) (Wiclax `.clax`), race.championchip.cz.
- Registrácia a záložné medzičasy: verejné web API [TRACX](https://tracx.events) (MYLAPS).

Appka nie je oficiálnou aplikáciou podujatia. Poloha medzi meraniami je odhad.

## Licencia

MIT
