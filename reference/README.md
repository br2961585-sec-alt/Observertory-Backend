# Observatory — UI Reference Implementation

This directory contains the standalone interactive reference prototype for the **Observatory 4-Tier Sunburst Privacy Radar**.

---

## 🎯 Purpose (For the Team)
This code is provided **strictly for reference** so the team can see the exact target visual styling, animation physics, and interaction design expected for the frontend dashboard.

### 🎥 Visual Demo & Motion Reference
Watch the short video demo showing the target radar look, ring highlights, and interaction dynamics:
👉 **[Watch the Sunburst Radar Reference on YouTube](https://www.youtube.com/shorts/cfytP6Eb5AM?feature=share)**

---

## 📂 File Overview

| File | Description |
| :--- | :--- |
| `botony.js` | D3.js (v7) rendering engine for the 4-tier radar canvas, nodes, tooltip triggers, and status pill. Contains full reference header comments. |
| `index.html` | Self-contained HTML entry point with SVG glow filters and HUD container structure. |
| `style.css` | Cyberpunk / dark-mode radar styling, SVG glowing filters, ring sector accents, and typography. |
| `d3.v7.min.js` | Bundled D3 v7 library for offline local viewing without internet/CDN dependencies. |
| `assembly.js` | Core assembly engine mapping application paths to ring sectors and computing deterministic geometry coordinates. |

---

## 🚀 How to View Locally

Simply open `index.html` in any modern web browser (Edge, Chrome, Firefox):
```powershell
# In PowerShell:
Start-Process "index.html"
```
Or serve with a simple local server:
```powershell
python -m http.server 8000
```
Then navigate to `http://localhost:8000` to interact with the radar.
