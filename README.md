# Rafal's Lines

A small phone web app showing the SLF avalanche bulletin and live snow/wind readings for ski areas near Lausanne, with a quick "is my slope in a core zone?" check.

- `index.html`: the app
- `spots.json`: the ski areas shown (edit to add or remove spots)
- `scripts/fetch.mjs`: downloads SLF data into `data/latest.json`
- `.github/workflows/update-data.yml`: runs the script every hour

Data: [WSL Institute for Snow and Avalanche Research SLF](https://www.slf.ch), CC BY 4.0.
This is an overview, not a replacement for the official bulletin.
