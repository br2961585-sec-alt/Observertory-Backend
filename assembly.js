/**
 * assembly.js — Observatory data assembly & 4-tier sunburst geometry engine.
 *
 * Responsibilities
 *  - Poll collector.json without overlapping requests (pauses when the tab is hidden).
 *  - Normalise every process into the physical 4-tier ring hierarchy.
 *  - Build area-proportional ring radii and app-count-proportional sector angles.
 *  - Apply the accordion (fisheye) weighting for a focused sector.
 *  - Place every node deterministically and keep that placement stable across polls.
 *
 * Geometry conventions
 *  - Angle 0 starts at 12 o'clock and increases clockwise (matches d3.arc).
 *  - Ring k occupies the radial band [r(k-1), r(k)] with r(0) = 0.
 *  - Area of ring k = π (r(k)^2 - r(k-1)^2).
 */

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // 2.399963...
const GOLDEN_RATIO_FRAC = 0.6180339887498949;

const fract = (n) => n - Math.floor(n);
const lower = (v) => String(v == null ? "" : v).toLowerCase();
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const RING_DEFS = {
  1: {
    ring: 1,
    title: "Windows core",
    zone: "Windows Core",
    fill: "#0d141d",
    accent: "#33506e",
    stroke: "#26374a",
    fallback: "Windows",
  },
  2: {
    ring: 2,
    title: "Drive space",
    zone: "Drive Space",
    fill: "#0a1a26",
    accent: "#3d7ea6",
    stroke: "#28536e",
    fallback: "Drive space",
  },
  3: {
    ring: 3,
    title: "User profiles",
    zone: "User Profile",
    fill: "#121022",
    accent: "#6d5bb0",
    stroke: "#4a3f78",
    fallback: "User",
  },
  4: {
    ring: 4,
    title: "User subdirectories",
    zone: "User Subdirectory",
    fill: "#081a17",
    accent: "#2f8f7c",
    stroke: "#226257",
    fallback: "AppData",
  },
};

const RING_FALLBACK = {
  1: RING_DEFS[1].fallback,
  2: RING_DEFS[2].fallback,
  3: RING_DEFS[3].fallback,
  4: RING_DEFS[4].fallback,
};

/* Kernel pseudo-processes have no executable path on disk. */
const PSEUDO_OS_KEYS = new Set([
  "system",
  "registry",
  "memcompression",
  "secure system",
  "system idle process",
  "idle",
  "gameinput",
]);

const WINDOWS_PATH_RE = /^[a-z]:\\windows(?:\\|$)/i;
const USERS_PATH_RE = /^[a-z]:\\users\\([^\\]+)(?:\\([^\\]+))?/i;

/* -------------------------------------------------------------------------- */
/* Small colour helpers                                                       */
/* -------------------------------------------------------------------------- */

function parseHex(hex) {
  const value = String(hex || "").trim().replace(/^#/, "");
  if (value.length === 3) {
    return [
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16),
    ];
  }
  if (value.length === 6) {
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }
  return [10, 14, 20];
}

function mixHex(from, to, amount) {
  const a = parseHex(from);
  const b = parseHex(to);
  const t = clamp(Number(amount) || 0, 0, 1);
  const channels = a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function hashString(value) {
  const text = String(value == null ? "" : value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

class AssemblyEngine {
  constructor(options = {}) {
    this.collectorUrl = options.collectorUrl || "../collector.json";
    this.refreshInterval = options.refreshInterval || 1500;

    this.nodeMap = new Map();
    this.sectors = [];
    this.sectorMap = new Map();
    this.cachedGeometry = null;

    this.meta = {};
    this.skeleton = {};
    this.activeUser = "";
    this.listeners = [];
    this.statusListeners = [];

    this._inflight = false;
    this._timer = null;
    this._failures = 0;
    this._status = "connecting";
  }

  onUpdate(callback) {
    if (typeof callback === "function") this.listeners.push(callback);
  }

  onStatus(callback) {
    if (typeof callback === "function") this.statusListeners.push(callback);
  }

  notifyListeners(data) {
    for (const cb of this.listeners) {
      try {
        cb(data);
      } catch (err) {
        console.error("AssemblyEngine listener error:", err);
      }
    }
  }

  notifyStatus(state, detail = {}) {
    const next = { state, ...detail };
    const changed =
      state !== this._status ||
      detail.reason !== this._statusReason ||
      detail.scanTime !== this._statusScanTime;

    this._status = state;
    this._statusReason = detail.reason;
    this._statusScanTime = detail.scanTime;
    if (!changed && this._statusNotified) return;
    this._statusNotified = true;

    for (const cb of this.statusListeners) {
      try {
        cb(next);
      } catch (err) {
        console.error("AssemblyEngine status listener error:", err);
      }
    }
  }

  async fetchCollectorData() {
    if (this._inflight) return null;
    this._inflight = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      const res = await fetch(`${this.collectorUrl}?_t=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("AssemblyEngine: collector.json unavailable —", err.message);
      }
      return null;
    } finally {
      clearTimeout(timeout);
      this._inflight = false;
    }
  }

  startPolling() {
    if (this._timer) return;

    const tick = async () => {
      if (document.visibilityState !== "hidden") {
        const data = await this.fetchCollectorData();
        if (data) {
          this._failures = 0;
          this.meta = data.meta || {
            timestamp: data.timestamp,
            scan_time: data.scan_time,
            total_apps_tracked: data.total_apps_tracked,
            running_apps_count: data.running_apps_count,
            active_hardware_count: data.active_hardware_count,
          };
          this.notifyStatus("live", {
            scanTime: this.meta.scan_time || data.scan_time || "",
            interval: this.refreshInterval,
          });
          this.notifyListeners(data);
        } else {
          this._failures += 1;
          const failedState =
            this._failures > 1 ? "offline" : this._status === "live" ? "live" : "connecting";
          this.notifyStatus(failedState, {
            reason: "collector.json could not be read",
            failures: this._failures,
          });
        }
      }
      this._timer = setTimeout(tick, this.refreshInterval);
    };

    this.notifyStatus("connecting");
    tick();
  }

  stopPolling() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Classification                                                         */
  /* ---------------------------------------------------------------------- */

  setSkeleton(skeleton) {
    this.skeleton = skeleton || {};
    const activeUser = this.skeleton.ring4_active_user && this.skeleton.ring4_active_user.username;
    if (activeUser) this.activeUser = lower(activeUser);
  }

  /**
   * Canonical ring after normalising collector quirks:
   *  - kernel pseudo-processes are Ring 1
   *  - anything launched under %SystemRoot% is Ring 1
   *  - Chromium PWAs and .lnk launches resolve into the user subdirectory layer
   *  - raw user-profile paths are re-checked against the active user
   */
  effectiveRing(app) {
    const sp = (app && app.spatial) || {};
    const raw = clamp(Number(sp.ring) || 2, 1, 4);
    const keys = (sp.location_keys || []).map(lower);
    const path = String((app && (app.path || app.exe_path)) || sp.full_address || "");
    const pathLower = path.replace(/\//g, "\\").toLowerCase();
    const names = [app && app.app_name, app && app.process_name, keys[0], keys[keys.length - 1]]
      .filter(Boolean)
      .map(lower);

    if (raw === 1) return 1;
    if (names.some((name) => PSEUDO_OS_KEYS.has(name))) return 1;
    if (WINDOWS_PATH_RE.test(pathLower)) return 1;
    if (sp.is_pwa) return 4;

    if (pathLower.endsWith(".lnk")) {
      if (pathLower.includes("\\appdata\\")) return 4;
      if (pathLower.includes("\\users\\")) return 3;
    }

    const usersMatch = pathLower.match(USERS_PATH_RE);
    if (usersMatch) {
      const profile = usersMatch[1];
      const subdirectory = usersMatch[2];
      if (!this.activeUser || profile === this.activeUser) {
        return subdirectory ? 4 : 3;
      }
      return 3;
    }

    if (raw === 4) return 4;
    if (raw === 3) return 3;
    return 2;
  }

  isOSComponent(app, ring) {
    return (ring != null ? ring : this.effectiveRing(app)) === 1;
  }

  /** The folder that becomes an angular sector for this app. */
  sectorNameFor(app, ring) {
    const sp = (app && app.spatial) || {};
    const keys = sp.location_keys || [];
    const path = sp.sector_path || [];

    if (ring === 1) return "Windows";
    if (ring === 4) return String(path[2] || keys[2] || RING_FALLBACK[4]);
    if (ring === 3) return String(path[1] || keys[1] || RING_FALLBACK[3]);

    const drivePath = path[0];
    if (drivePath) {
      const parts = String(drivePath)
        .split(/[\\/]/)
        .filter(Boolean);
      const leaf = parts[parts.length - 1];
      if (leaf) return leaf;
    }
    return String(keys[0] || RING_FALLBACK[2]);
  }

  /** Stable identity for a sector: two drive folders with the same leaf stay distinct. */
  sectorKeyFor(app, ring) {
    const sp = (app && app.spatial) || {};
    const path = sp.sector_path || [];
    const name = this.sectorNameFor(app, ring);

    if (ring === 2 && path[0]) return `2:${lower(path[0])}`;
    return `${ring}:${lower(name)}`;
  }

  /** Largest node radius in a bucket, used to keep every dot inside its band. */
  maxNodeRadius(app) {
    if (!app) return 6;
    if ((app.microphone && app.microphone.active) || (app.webcam && app.webcam.active)) return 14;
    if (app.file_reach && app.file_reach.has_access) return 10.5;
    return 6;
  }

  _nodeState(app, ring) {
    const mic = Boolean(app && app.microphone && app.microphone.active);
    const cam = Boolean(app && app.webcam && app.webcam.active);
    const file = Boolean(app && app.file_reach && app.file_reach.has_access);

    if (mic || cam) {
      return {
        radius: 14,
        fill: "#ff0055",
        stroke: "#ffd9e5",
        pulse: true,
        isLit: true,
        level: "alarm",
      };
    }
    if (file) {
      return {
        radius: 10.5,
        fill: "#a855f7",
        stroke: "#e9d5ff",
        pulse: false,
        isLit: true,
        level: "file",
      };
    }

    const palettes = {
      1: { fill: "#22324a", stroke: "#4a6280" },
      2: { fill: "#1a3047", stroke: "#356484" },
      3: { fill: "#2f2450", stroke: "#665096" },
      4: { fill: "#17443a", stroke: "#2b7d6e" },
    };
    const palette = palettes[ring] || palettes[2];

    return {
      radius: 6,
      fill: palette.fill,
      stroke: palette.stroke,
      pulse: false,
      isLit: false,
      level: "dull",
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Geometry                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Area-proportional concentric sunburst.
   *   Area_k = π (r_k^2 - r_(k-1)^2)  ->  r_k = sqrt(sum(area_1..k) / π)
   * Angular span is proportional to app count, with an optional accordion
   * focus that multiplies one sector by 2.2x while neighbours shrink by 0.7x.
   */
  computeSunburstGeometry(
    apps,
    skeleton,
    centerX,
    centerY,
    maxRadius,
    focusedSectorKey = null,
  ) {
    this.setSkeleton(skeleton);

    const running = (apps || []).filter((app) => app && app.is_running !== false);
    const buckets = { 1: [], 2: [], 3: [], 4: [] };
    for (const app of running) {
      const ring = this.effectiveRing(app);
      (buckets[ring] || buckets[2]).push(app);
    }

    const counts = {
      1: buckets[1].length,
      2: buckets[2].length,
      3: buckets[3].length,
      4: buckets[4].length,
    };
    const total = Math.max(running.length, 1);
    const R = Math.max(Number(maxRadius) || 0, 120);

    /*
     * Every occupied ring keeps a small area floor so a single app still has a
     * usable track. Empty rings collapse to a hairline — never a labelled band.
     */
    const area = { 1: 0, 2: 0, 3: 0, 4: 0 };
    if (running.length === 0) {
      // Empty collector: keep the instrument's four tracks visible without
      // inventing any applications.
      area[1] = 0.4;
      area[2] = 0.2;
      area[3] = 0.2;
      area[4] = 0.2;
    } else {
      let baseSum = 0;
      for (const ring of [1, 2, 3, 4]) {
        area[ring] = counts[ring] > 0 ? 0.08 : 0.006;
        baseSum += area[ring];
      }
      const flex = Math.max(0, 1 - baseSum);
      for (const ring of [1, 2, 3, 4]) {
        area[ring] += (flex * counts[ring]) / total;
      }
    }

    const sqrtR = (value) => R * Math.sqrt(Math.max(value, 0));
    let r1 = sqrtR(area[1]);
    let r2 = sqrtR(area[1] + area[2]);
    let r3 = sqrtR(area[1] + area[2] + area[3]);
    const r4 = R;

    // Keep each populated track wide enough for its largest node.
    const minCore = Math.min(64, R * 0.22);
    const minThickness = {
      1: minCore,
      2: Math.max(18, counts[2] > 0 ? 2 * Math.max(...buckets[2].map((a) => this.maxNodeRadius(a)), 6) + 6 : 2),
      3: Math.max(16, counts[3] > 0 ? 2 * Math.max(...buckets[3].map((a) => this.maxNodeRadius(a)), 6) + 6 : 2),
      4: Math.max(20, counts[4] > 0 ? 2 * Math.max(...buckets[4].map((a) => this.maxNodeRadius(a)), 6) + 6 : 2),
    };

    r1 = Math.max(r1, minThickness[1]);
    r2 = Math.max(r2, r1 + minThickness[2]);
    r3 = Math.max(r3, r2 + minThickness[3]);
    r3 = Math.min(r3, r4 - Math.min(minThickness[4], R * 0.24));
    r2 = Math.min(r2, r3 - Math.min(minThickness[3], Math.max(2, r3 * 0.12)));
    r1 = Math.min(r1, r2 - Math.min(minThickness[2], Math.max(2, r2 * 0.18)));
    r1 = Math.max(r1, Math.min(40, R * 0.14));

    const ringDefs = [1, 2, 3, 4].map((ring) => ({
      ring,
      name: RING_DEFS[ring].title,
      title: RING_DEFS[ring].title,
      zone: RING_DEFS[ring].zone,
      fill: RING_DEFS[ring].fill,
      accent: RING_DEFS[ring].accent,
      stroke: RING_DEFS[ring].stroke,
      r0: ring === 1 ? 0 : [0, 0, r1, r2, r3][ring],
      r1: [0, r1, r2, r3, r4][ring],
      appCount: counts[ring],
      occupied: counts[ring] > 0,
    }));

    this.sectors = [];
    this.sectorMap.clear();

    // Ring 1 — one solid core disc, never divided by folders.
    const coreFocused = false;
    this._pushSector({
      ring: 1,
      name: RING_DEFS[1].title,
      key: "1:windows",
      startAngle: 0,
      endAngle: TAU,
      r0: 0,
      r1,
      appCount: counts[1],
      index: 0,
      focused: coreFocused,
      centerX,
      centerY,
      label: { visible: false, x: centerX, y: centerY, outside: false },
      appsPreview: buckets[1].slice(0, 5).map((app) => app.app_name || app.process_name),
    });

    // Rings 2–4 — sectors only for directories that actually contain running apps.
    for (const ring of [2, 3, 4]) {
      const groups = new Map();
      for (const app of buckets[ring]) {
        const key = this.sectorKeyFor(app, ring);
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            name: this.sectorNameFor(app, ring),
            apps: [],
          });
        }
        groups.get(key).apps.push(app);
      }
      if (groups.size === 0) continue;

      // Stable alphabetical order: sectors never jump between polls.
      const entries = Array.from(groups.values()).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
      );

      let weights = entries.map((entry) => Math.max(entry.apps.length, 1));
      let focusedIndex = -1;
      const focusKey = focusedSectorKey ? lower(focusedSectorKey) : null;
      if (entries.length > 1 && focusKey) {
        focusedIndex = entries.findIndex(
          (entry) =>
            lower(entry.key) === focusKey ||
            lower(`${ring}:${entry.name}`) === focusKey ||
            lower(entry.name) === focusKey,
        );
        if (focusedIndex !== -1) {
          weights = weights.map((weight, index) => (index === focusedIndex ? weight * 2.2 : weight * 0.7));
        }
      }

      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
      const def = RING_DEFS[ring];
      const band = ringDefs[ring - 1];
      const anglePad = 0.0001;

      // When a sector is focused, grow it around its original mid-angle. If it
      // instead shoved its neighbours aside, it would rotate away from the
      // stationary pointer and immediately un-hover itself.
      const angles = new Array(entries.length);
      if (focusedIndex !== -1) {
        const originalTotal = entries.reduce((sum, entry) => sum + Math.max(entry.apps.length, 1), 0) || 1;
        let originalCursor = 0;
        const originalMidAngles = entries.map((entry) => {
          const span = (Math.max(entry.apps.length, 1) / originalTotal) * TAU;
          const mid = originalCursor + span / 2;
          originalCursor += span;
          return mid;
        });

        const focusedSpan = (weights[focusedIndex] / totalWeight) * TAU;
        const focusedMid = originalMidAngles[focusedIndex];
        angles[focusedIndex] = {
          startAngle: focusedMid - focusedSpan / 2,
          endAngle: focusedMid + focusedSpan / 2,
        };

        const otherWeight = totalWeight - weights[focusedIndex];
        const otherSpan = TAU - focusedSpan;
        let cursor = angles[focusedIndex].endAngle;
        for (let step = 1; step < entries.length; step += 1) {
          const index = (focusedIndex + step) % entries.length;
          const span = otherWeight > 0 ? (weights[index] / otherWeight) * otherSpan : otherSpan / (entries.length - 1);
          angles[index] = { startAngle: cursor, endAngle: cursor + span };
          cursor += span;
        }
      } else {
        let cursor = 0;
        entries.forEach((entry, index) => {
          const span = (weights[index] / totalWeight) * TAU;
          angles[index] = { startAngle: cursor, endAngle: cursor + span };
          cursor += span;
        });
      }

      entries.forEach((entry, index) => {
        const startAngle = angles[index].startAngle + (entries.length > 1 ? anglePad : 0);
        const endAngle = angles[index].endAngle - (entries.length > 1 ? anglePad : 0);
        const midAngle = (startAngle + endAngle) / 2;
        const midRadius = (band.r0 + band.r1) / 2;
        const focused = index === focusedIndex;
        const canLabelOutside = ring === 4 && R >= 300 && endAngle - startAngle >= 0.26;
        const bandThickness = band.r1 - band.r0;
        // In-band labels sit in a reserved outer lane so application dots never
        // collide with the inscription.
        const labelInset = Math.min(20, Math.max(11, bandThickness * 0.22));
        const labelRadius = canLabelOutside ? band.r1 + 18 : band.r1 - labelInset;

        this._pushSector({
          ring,
          name: entry.name,
          key: entry.key,
          startAngle,
          endAngle,
          r0: band.r0,
          r1: band.r1,
          appCount: entry.apps.length,
          index,
          focused,
          centerX,
          centerY,
          label: {
            visible:
              entry.apps.length > 0 &&
              endAngle - startAngle >= (canLabelOutside ? 0.26 : 0.12) &&
              (band.r1 - band.r0 > 12 || canLabelOutside),
            x: centerX + labelRadius * Math.sin(midAngle),
            y: centerY - labelRadius * Math.cos(midAngle),
            radius: labelRadius,
            outside: canLabelOutside,
          },
          appsPreview: entry.apps.slice(0, 5).map((app) => app.app_name || app.process_name),
        });
      });
    }

    const signature = [
      centerX.toFixed(1),
      centerY.toFixed(1),
      R.toFixed(1),
      focusedSectorKey || "-",
      ringDefs.map((ring) => `${ring.ring}:${ring.r0.toFixed(1)}-${ring.r1.toFixed(1)}`).join(","),
      this.sectors
        .map((sector) => `${sector.key}:${sector.startAngle.toFixed(4)}:${sector.endAngle.toFixed(4)}:${sector.appCount}`)
        .join(","),
    ].join("|");

    this.cachedGeometry = { rings: ringDefs, sectors: this.sectors, signature };
    return this.cachedGeometry;
  }

  _pushSector({
    ring,
    name,
    key,
    startAngle,
    endAngle,
    r0,
    r1,
    appCount,
    index,
    focused,
    centerX,
    centerY,
    label,
    appsPreview,
  }) {
    const midAngle = (startAngle + endAngle) / 2;
    const midRadius = (r0 + r1) / 2;
    const def = RING_DEFS[ring];
    const fill = mixHex(def.fill, def.accent, (focused ? 0.17 : 0.05 + (index % 3) * 0.026));

    const sector = {
      ring,
      name,
      key,
      startAngle,
      endAngle,
      innerRadius: r0,
      outerRadius: r1,
      midRadius,
      midAngle,
      span: endAngle - startAngle,
      color: fill,
      stroke: def.stroke,
      appCount,
      focused,
      label: label || { visible: false, x: centerX, y: centerY, outside: false },
      appsPreview: appsPreview || [],
      centroid: {
        x: centerX + midRadius * Math.sin(midAngle),
        y: centerY - midRadius * Math.cos(midAngle),
      },
    };

    this.sectors.push(sector);
    this.sectorMap.set(key, sector);
    return sector;
  }

  _firstSectorOf(ring) {
    return this.sectors.find((sector) => sector.ring === ring) || null;
  }

  /* ---------------------------------------------------------------------- */
  /* Node placement                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Deterministic target position inside the subject's sector.
   *  - Ring 1: sunflower / Vogel spiral over the core disc.
   *  - Rings 2-4: area-weighted radial band + golden-ratio angular offset.
   */
  resolveTargetCoordinates(subject, centerX, centerY, maxRadius) {
    const ring = clamp(Number(subject.ring) || 2, 1, 4);
    const nodeRadius = clamp(Number(subject.radius) || 6, 1, 40);

    if (ring === 1) {
      const core = this.cachedGeometry && this.cachedGeometry.rings[0];
      const coreR = core ? core.r1 : Math.min(maxRadius, 160);
      const count = Math.max(subject._ringCount || 1, 1);
      const i = clamp(subject._ringIndex || 0, 0, count - 1);
      const maxR = Math.max(coreR - nodeRadius - 6, 12);
      const r = maxR * Math.sqrt((i + 0.5) / count);
      const angle = i * GOLDEN_ANGLE;
      return {
        targetX: centerX + r * Math.cos(angle),
        targetY: centerY + r * Math.sin(angle),
        sectorKey: "1:windows",
        sectorName: "Windows",
      };
    }

    const sector = this.sectorMap.get(subject.sectorKey) || this._firstSectorOf(ring);

    if (sector) {
      const count = Math.max(subject._sectorCount || 1, 1);
      const i = clamp(subject._sectorIndex || 0, 0, count - 1);
      const span = Math.max(sector.endAngle - sector.startAngle, 0.0001);
      const band = Math.max(sector.outerRadius - sector.innerRadius, 1);
      const padR = Math.min(band * 0.22, nodeRadius + 4);
      const padA = Math.min(Math.max((nodeRadius * 1.25) / Math.max(sector.midRadius, 1), 0.008), span * 0.18);
      const inner = sector.innerRadius + padR;
      const labelLane =
        sector.label && sector.label.visible && !sector.label.outside
          ? Math.min(22, Math.max(14, (sector.outerRadius - sector.innerRadius) * 0.26))
          : 0;
      const outer = Math.max(sector.outerRadius - padR - labelLane, inner + 1);
      const t = (i + 0.5) / count;
      const r = Math.sqrt(inner * inner + t * (outer * outer - inner * inner));
      const angle =
        sector.startAngle +
        padA +
        fract(i * GOLDEN_RATIO_FRAC + 0.19) * Math.max(span - 2 * padA, 0.0001);

      return {
        targetX: centerX + r * Math.sin(angle),
        targetY: centerY - r * Math.cos(angle),
        sectorKey: sector.key,
        sectorName: sector.name,
      };
    }

    // Last-resort deterministic placement inside the correct radial band.
    const def = this.cachedGeometry && this.cachedGeometry.rings[ring - 1];
    const bandMid = def ? (def.r0 + def.r1) / 2 : Math.max(maxRadius - 40, 60);
    const angle = (hashString(subject.id || subject.process_name || "app") % 3600) / 3600 * TAU;
    return {
      targetX: centerX + bandMid * Math.sin(angle),
      targetY: centerY - bandMid * Math.cos(angle),
      sectorKey: null,
      sectorName: RING_DEFS[ring].title,
    };
  }

  /**
   * Rebuild / mutate nodes in place. Existing node objects keep x, y, vx, vy
   * so a 1.5s telemetry refresh never causes a visual snap.
   *
   * Returns { nodes, structureChanged, added, removed }.
   */
  processAppNodes(rawApps, centerX, centerY, maxRadius) {
    const running = (rawApps || []).filter((app) => app && app.is_running !== false);
    const buckets = { 1: [], 2: [], 3: [], 4: [] };
    for (const app of running) {
      const ring = this.effectiveRing(app);
      (buckets[ring] || buckets[2]).push(app);
    }

    const nameOf = (app) => String((app && (app.app_name || app.process_name)) || "");
    const pidOf = (app) => (app && (app.primary_pid || (app.pids && app.pids[0]))) || 0;

    for (const ring of [1, 2, 3, 4]) {
      buckets[ring].sort(
        (a, b) =>
          nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }) || pidOf(a) - pidOf(b),
      );
    }

    const items = [];
    for (const ring of [1, 2, 3, 4]) {
      buckets[ring].forEach((app, ringIndex) => {
        const sectorName = this.sectorNameFor(app, ring);
        const sectorKey = this.sectorKeyFor(app, ring);
        const sector = this.sectorMap.get(sectorKey) || this._firstSectorOf(ring);
        const state = this._nodeState(app, ring);
        items.push({
          app,
          ring,
          ringIndex,
          ringCount: buckets[ring].length,
          sectorKey: sector ? sector.key : sectorKey,
          sectorName: sector ? sector.name : sectorName,
          sector,
          state,
        });
      });
    }

    const sectorCounts = new Map();
    for (const item of items) {
      const key = item.sectorKey || `ring${item.ring}`;
      if (!sectorCounts.has(key)) sectorCounts.set(key, []);
      sectorCounts.get(key).push(item);
    }
    for (const list of sectorCounts.values()) {
      list.forEach((item, index) => {
        item.sectorIndex = index;
        item.sectorCount = list.length;
      });
    }

    const usedIds = new Set();
    const result = [];
    const now = Date.now();
    let added = 0;
    let structureChanged = false;

    for (const item of items) {
      const { app, ring, state } = item;
      const pid = pidOf(app);

      // Display names are unique upstream; they survive a PID churn far better
      // than a primary PID does, which keeps an app's node in place across scans.
      const baseId =
        lower(app.app_name || app.process_name || app.path || app.primary_pid || "app") || `app-${item.ringIndex}`;
      let id = baseId;
      let suffix = 1;
      while (usedIds.has(id)) {
        suffix += 1;
        id = `${baseId}#${suffix}`;
      }
      usedIds.add(id);

      const coords = this.resolveTargetCoordinates(
        {
          ring,
          radius: state.radius,
          sectorKey: item.sectorKey,
          _ringIndex: item.ringIndex,
          _ringCount: item.ringCount,
          _sectorIndex: item.sectorIndex,
          _sectorCount: item.sectorCount,
          process_name: app.process_name,
          id,
        },
        centerX,
        centerY,
        maxRadius,
      );

      const micActive = Boolean(app.microphone && app.microphone.active);
      const camActive = Boolean(app.webcam && app.webcam.active);
      const fileReach = Boolean(app.file_reach && app.file_reach.has_access);

      const existing = this.nodeMap.get(id);
      if (existing) {
        const moved =
          Math.abs(existing.targetX - coords.targetX) > 0.5 ||
          Math.abs(existing.targetY - coords.targetY) > 0.5;
        const ringChanged = existing.ring !== ring;
        const visualChanged =
          existing.radius !== state.radius ||
          existing.color !== state.fill ||
          existing.strokeColor !== state.stroke;

        existing.pid = pid;
        existing.pids = app.pids || [];
        existing.app_name = app.app_name || app.process_name;
        existing.process_name = app.process_name;
        existing.path = app.path || app.exe_path || "";
        existing.spatial = app.spatial;
        existing.microphone = app.microphone;
        existing.webcam = app.webcam;
        existing.file_reach = app.file_reach;
        existing.ring = ring;
        existing.sectorKey = item.sectorKey;
        existing.sectorName = item.sectorName;
        existing._ringIndex = item.ringIndex;
        existing._ringCount = item.ringCount;
        existing._sectorIndex = item.sectorIndex;
        existing._sectorCount = item.sectorCount;
        existing.targetX = coords.targetX;
        existing.targetY = coords.targetY;
        existing.radius = state.radius;
        existing.color = state.fill;
        existing.strokeColor = state.stroke;
        existing.pulse = state.pulse;
        existing.isOS = ring === 1;
        existing.isLit = state.isLit;
        existing.isDull = state.level === "dull";
        existing.level = state.level;
        existing.micActive = micActive;
        existing.camActive = camActive;
        existing.fileReach = fileReach;
        existing._moved = moved || ringChanged || visualChanged;
        existing._isNew = false;
        existing.seenAt = now;
        if (moved || ringChanged) structureChanged = true;
        result.push(existing);
      } else {
        const jitterSeed = (hashString(id) % 1000) / 1000;
        const jitterAngle = jitterSeed * TAU;
        const jitter = 1.5 + (hashString(`${id}:j`) % 1000) / 200;
        const node = {
          id,
          pid,
          pids: app.pids || [],
          x: coords.targetX + Math.cos(jitterAngle) * jitter,
          y: coords.targetY + Math.sin(jitterAngle) * jitter,
          vx: 0,
          vy: 0,
          targetX: coords.targetX,
          targetY: coords.targetY,
          ring,
          sectorKey: item.sectorKey,
          sectorName: item.sectorName,
          _ringIndex: item.ringIndex,
          _ringCount: item.ringCount,
          _sectorIndex: item.sectorIndex,
          _sectorCount: item.sectorCount,
          app_name: app.app_name || app.process_name,
          process_name: app.process_name,
          path: app.path || app.exe_path || "",
          spatial: app.spatial,
          microphone: app.microphone,
          webcam: app.webcam,
          file_reach: app.file_reach,
          radius: state.radius,
          color: state.fill,
          strokeColor: state.stroke,
          pulse: state.pulse,
          isOS: ring === 1,
          isLit: state.isLit,
          isDull: state.level === "dull",
          level: state.level,
          micActive,
          camActive,
          fileReach,
          _moved: true,
          _isNew: true,
          seenAt: now,
        };
        this.nodeMap.set(id, node);
        result.push(node);
        added += 1;
        structureChanged = true;
      }
    }

    let removed = 0;
    for (const [id, node] of this.nodeMap) {
      if (node.seenAt !== now) {
        this.nodeMap.delete(id);
        removed += 1;
        structureChanged = true;
      }
    }

    return { nodes: result, structureChanged, added, removed };
  }

  /** Recompute targets for existing nodes after an accordion focus change. */
  retargetNodes(nodes, centerX, centerY, maxRadius) {
    let moved = false;
    for (const node of nodes) {
      const coords = this.resolveTargetCoordinates(node, centerX, centerY, maxRadius);
      if (
        Math.abs(node.targetX - coords.targetX) > 0.5 ||
        Math.abs(node.targetY - coords.targetY) > 0.5
      ) {
        moved = true;
      }
      node.targetX = coords.targetX;
      node.targetY = coords.targetY;
      if (coords.sectorKey) node.sectorKey = coords.sectorKey;
      if (coords.sectorName) node.sectorName = coords.sectorName;
    }
    return moved;
  }
}

AssemblyEngine.RING_DEFS = RING_DEFS;
AssemblyEngine.TAU = TAU;

// Universal Module Definition (UMD) & Bundler Interop
if (typeof module !== "undefined" && module.exports) {
  module.exports = AssemblyEngine;
  module.exports.AssemblyEngine = AssemblyEngine;
  module.exports.RING_DEFS = RING_DEFS;
  module.exports.TAU = TAU;
  module.exports.default = AssemblyEngine;
}
if (typeof window !== "undefined") {
  window.AssemblyEngine = AssemblyEngine;
}
if (typeof globalThis !== "undefined") {
  globalThis.AssemblyEngine = AssemblyEngine;
}

