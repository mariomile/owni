# Font

Distribuiti con Owni per non dipendere da CDN esterne (la console ha `default-src 'self'`).
Presi dai pacchetti npm `@fontsource-variable/archivo@5.3.0` (sottoinsiemi latin e latin-ext, peso 100-900 e larghezza 62-125% variabili) e `@fontsource/monaspace-neon@5.3.0` (latin, pesi 400 e 500).

| File | Font | Licenza |
|---|---|---|
| `archivo-latin.woff2`, `archivo-latin-ext.woff2` | Archivo (The Archivo Project Authors, Omnibus-Type) | SIL OFL 1.1, testo in [`OFL-Archivo.txt`](OFL-Archivo.txt) |
| `monaspace-neon-latin-400.woff2`, `monaspace-neon-latin-500.woff2` | Monaspace Neon (GitHub) | SIL OFL 1.1, testo in [`OFL-Monaspace.txt`](OFL-Monaspace.txt) |

## Grafici

I grafici (ADR 0030) non usano un file di font: i contorni delle lettere latine di DejaVu Sans e DejaVu Sans Bold sono copiati in `src/core/chart-font.ts` da `scripts/chart-font.ts`. Licenza Bitstream Vera (i cambiamenti di DejaVu sono di pubblico dominio), riportata per intero in testa a quel file. Le lettere copiate sono quelle di Bitstream Vera e di DejaVu, non quelle aggiunte dai font Arev.
