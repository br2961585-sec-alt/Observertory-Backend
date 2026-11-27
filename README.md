# Observatory — Backend & Data Assembly Engines

This repository contains the standalone local backend and spatial geometry engines for **Observatory**. It enables your team to capture live Windows hardware/filesystem telemetry and translate it directly into 4-tier spatial coordinates for any web dashboard.

---

## Architecture: The Three Core Engines

Observatory operates without an external cloud backend or intermediate HTTP server. All data gathering happens locally on the user's machine:

```
+-------------------------------------------------------------+
| 1. Local Python Telemetry Engine (acquired.py)              |
|    - Inspects WASAPI audio capture sessions (Microphone)    |
|    - Reads Windows ConsentStore registry (Camera & Mic)     |
|    - Watches sensitive user folders (Pictures, Docs, etc.)  |
|    - Classifies process paths into 4-tier ring hierarchy    |
+-------------------------------------------------------------+
                              |
                              v  (Periodically writes)
+-------------------------------------------------------------+
| 2. Telemetry State Contract (collector.json)                |
|    - Unified JSON snapshot of running apps, hardware status,|
|      filesystem reaches, and disk skeleton structure        |
+-------------------------------------------------------------+
                              |
                              v  (Ingested by)
+-------------------------------------------------------------+
| 3. Web UI Geometry & Assembly Engine (assembly.js)          |
|    - Normalizes apps into 4 physical ring sectors           |
|    - Computes area-proportional radii & sector angles       |
|    - Resolves deterministic target (x, y) coordinates       |
|    - Manages accordion fisheye weighting on hover/focus     |
|    - Feeds ready-to-draw nodes to your web dashboard        |
+-------------------------------------------------------------+
```

---

## File Structure

| File | Purpose |
| :--- | :--- |
| `acquired.py` | 100% self-contained local Python daemon gathering hardware & filesystem telemetry (Zero dependencies). |
| `collector.json` | Telemetry data snapshot and schema contract (pre-seeded for offline dev). |
| `assembly.js` | Universal data assembly and 4-tier sunburst geometry engine. |
| `run_acquired.bat` | 1-click Windows batch launcher for `acquired.py`. |
| `install_dependencies.bat` | 1-click batch installer for `acquired.py` accelerator dependencies (`psutil`, `pycaw`, `watchdog`). |
| `requirements.txt` | Python package dependency specifications. |
| `reference/` | Interactive UI prototype & visual reference for the 4-tier sunburst radar ([YouTube Demo](https://www.youtube.com/shorts/cfytP6Eb5AM?feature=share)). |
| `REFERENCES.md` | Attributions for open-source GitHub references adapted into the engines. |
| `.gitignore` | Standard exclusions for temporary, PID, and cache files. |

---

## Quickstart: Running the Telemetry Engine

### 1. Prerequisites
- **OS:** Windows 10 or Windows 11 (64-bit).
- **Python:** Standard Python 3.9+ (No pip packages required!).

### 2. Zero-Install / Zero Dependencies
The engine is 100% self-contained and runs using Python's standard library with native Windows kernel and registry APIs (`ctypes`, `winreg`):
- **Zero `pip install` required.**
- **Zero virtual environments required.**

### 3. Start the Daemon
Double-click `run_acquired.bat` or run via terminal:
```powershell
python acquired.py 1.5
```
*(The optional argument `1.5` specifies the refresh interval in seconds.)*

The daemon will continuously update `collector.json` in place with atomic file replacements.

---

## Web UI Integration: Using `assembly.js`

`assembly.js` is bundled with a Universal Module Definition (UMD), making it compatible with vanilla HTML `<script>` tags, CommonJS (`require`), and ES Modules (`import`).

### Vanilla HTML / JavaScript
```html
<script src="assembly.js"></script>
<script>
  const engine = new AssemblyEngine();

  async function updateDashboard() {
    const response = await fetch("collector.json");
    const data = await response.json();

    const width = 800;
    const height = 800;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(width, height) * 0.44;

    // 1. Calculate radial ring bands and sector arcs
    const geometry = engine.computeSunburstGeometry(
      data.apps,
      data.skeleton,
      centerX,
      centerY,
      maxRadius
    );

    // 2. Resolve (x, y) coordinates and styling for each running application node
    const { nodes, structureChanged } = engine.processAppNodes(
      data.apps,
      centerX,
      centerY,
      maxRadius
    );

    // 3. Render nodes with your visualization library (D3.js, Canvas, SVG, Three.js)
    console.log("Computed app nodes:", nodes);
  }

  setInterval(updateDashboard, 1500);
</script>
```

### Modern Bundlers (React, Vue, Svelte, Vite, Next.js)
```javascript
import { AssemblyEngine, RING_DEFS } from "./assembly.js";

const engine = new AssemblyEngine();

// Ingest telemetry JSON:
const geometry = engine.computeSunburstGeometry(telemetry.apps, telemetry.skeleton, cx, cy, radius);
const { nodes } = engine.processAppNodes(telemetry.apps, cx, cy, radius);
```

---

## The 4-Tier Spatial Hierarchy

Every application is categorized into one of four concentric physical rings based on launch location:

1. **Ring 1: Windows Core** (`C:\Windows\`) — Core OS services, kernel pseudo-processes (`System`, `Registry`).
2. **Ring 2: Drive Space** (`C:\Program Files`, `C:\Program Files (x86)`, custom drives) — Installed system-wide software.
3. **Ring 3: User Profiles** (`C:\Users\<user>\`) — User-installed standalone tools, Public directories.
4. **Ring 4: User Subdirectories** (`C:\Users\<user>\AppData`, `Downloads`, etc.) — AppData binaries, portable apps, PWAs.

---

## Telemetry Schema Summary (`collector.json`)

```json
{
  "meta": {
    "version": "1.0.0",
    "timestamp": 1794825116.22,
    "scan_time": "2026-11-16 16:01:56",
    "refresh_interval_sec": 1.5,
    "active_user": "bhuva",
    "total_apps_tracked": 120,
    "running_apps_count": 103,
    "active_hardware_count": 0,
    "apps_with_file_reach": 0
  },
  "skeleton": {
    "ring1_windows": ["Windows"],
    "ring2_drive": ["C:\\Program Files", "C:\\Program Files (x86)"],
    "ring3_users": ["bhuva", "Public"],
    "ring4_active_user": {
      "username": "bhuva",
      "subdirectories": ["AppData", "Downloads", "Documents", "Pictures"]
    }
  },
  "apps": [
    {
      "app_name": "Chrome",
      "process_name": "chrome.exe",
      "primary_pid": 14208,
      "pids": [14208, 12840],
      "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "is_running": true,
      "spatial": {
        "ring": 2,
        "zone": "Drive Space",
        "location_keys": ["C:\\Program Files", "Google", "Chrome"]
      },
      "microphone": { "active": false },
      "webcam": { "active": false },
      "file_reach": {
        "has_access": false,
        "folders_touched": []
      }
    }
  ]
}
```

---

## Pushing to GitHub

To push this standalone backend package to your own GitHub repository:

```powershell
cd observatory-backend
git init
git add .
git commit -m "feat: initial commit of observatory backend engines"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo-name>.git
git push -u origin main
```
