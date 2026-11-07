# Offline Newspaper Editions

## Overview

NewsGPT now generates self-contained newspaper editions in the `editions/YYYY-MM-DD/` directory. Each edition is a complete, standalone folder that can be opened directly in any browser via `file://` protocol — **no web server required**.

## Quick Start

1. **Build the newspaper:**
   ```bash
   npm run paper
   ```
   This runs `merge.js` (consolidate Hermes chunks) and `build.js` (render the edition).

2. **Open in browser:**
   - **Windows**: `file:///C:/Users/John/Documents/_code/Ai_Newspaper/NewsGPT/editions/2026-11-01/index.html`
   - **macOS/Linux**: `file:///path/to/NewsGPT/editions/2026-11-01/index.html`
   - Or simply double-click `editions/2026-11-01/index.html` in your file manager

3. **That's it!** The newspaper displays with all styling, interactivity, and data embedded in the single HTML file.

## Directory Structure

Each dated edition folder contains three files:

```
editions/
├── 2026-11-01/
│   ├── index.html     # Self-contained newspaper (includes all data)
│   ├── app.js         # Rendering logic
│   └── style.css      # Styles
├── 2026-10-31/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── ...
```

## How It Works

### Traditional Mode (web/editions.js)
- Used when you have a web server or want multiple editions in one view
- `web/editions.js` contains all editions bundled as JavaScript
- Browser loads `web/index.html` which fetches `editions.js` to get the edition picker

### Offline Mode (editions/YYYY-MM-DD/index.html)
- Each edition is completely standalone
- Edition data is embedded directly in the HTML as `window.EDITION`
- No external fetches — works over `file://` protocol
- Perfect for sharing, archiving, or reading without internet

## Features

✅ **Self-contained** — Copy/move/archive the folder anywhere  
✅ **No server** — Opens directly from disk in any browser  
✅ **Portable** — Works on Windows, macOS, Linux  
✅ **Dark mode** — Toggle in the UI  
✅ **Responsive** — Desktop, tablet, and mobile friendly  
✅ **Auditable** — Every story linked to original sources  

## Usage with Hermes

### After Hermes skills run on VM:

1. Hermes writes JSON to `NewsGPT/data/inbox/YYYY-MM-DD.json`
2. Call: `npm run paper` (or `node merge.js && node build.js`)
3. Edition appears at: `NewsGPT/editions/YYYY-MM-DD/index.html`
4. Open in browser via `file://` URL

### Hermes Integration Template

In your Hermes skill hook or post-run script:

```bash
#!/bin/bash
# After all ticker skills complete

cd /path/to/NewsGPT
npm run paper

# The edition is now ready
echo "Newspaper available at: editions/$(date +%Y-%m-%d)/index.html"
```

## Backward Compatibility

The changes are **fully backward compatible**:

- Legacy `web/index.html` + `web/editions.js` still work (browser-based multi-edition picker)
- Offline `editions/YYYY-MM-DD/index.html` is new (standalone single edition)
- `app.js` detects which mode it's running in and behaves accordingly

## Testing

```bash
# Run the build with sample data
npm run paper

# Check the output
ls -la editions/2026-10-22/

# Open in browser
open editions/2026-10-22/index.html    # macOS
xdg-open editions/2026-10-22/index.html  # Linux
start editions/2026-10-22/index.html    # Windows
```

## Tips

- **Archive editions**: Each dated folder is immutable once created, perfect for keeping a daily archive
- **Sharing**: Email or chat the entire `editions/YYYY-MM-DD/` folder — recipients can open it instantly
- **Offline reading**: Download the folder to your phone or tablet, read without network access
- **Automation**: Cron/Task Scheduler can run `npm run paper` after Hermes completes, folder auto-updates

---

That's all! You now have a newspaper that lives in the file system and needs nothing but a browser to read.
