/**
 * ============================================================================
 * OBSERVATORY UI REFERENCE IMPLEMENTATION: 4-TIER SUNBURST RADAR
 * ============================================================================
 *
 * NOTE FOR THE TEAM:
 * This file is included in this repository PURELY FOR REFERENCE to demonstrate
 * how the user interface (UI) and user experience (UX) of the 4-tier sunburst
 * radar should look and behave when rendered.
 *
 * Visual Reference Video / Demo:
 * Please visit the following link to view the motion design, hover effects,
 * ring sectors, and interactive radar behavior:
 * 👉 https://www.youtube.com/shorts/cfytP6Eb5AM?feature=share
 *
 * Architecture Summary:
 * - Powered by D3.js (v7) and assembly.js.
 * - Renders 4 concentric directory rings (Windows Core, Drive Space, User Profile,
 *   User Subdirectory).
 * - Computes angular sector dividers, folder labels, and dynamic node dots.
 * - Application names, PIDs, and process details are presented via floating HUD/tooltips.
 *
 * Please use this reference when integrating or rebuilding the frontend dashboard.
 * ============================================================================
 */

document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  const container = document.getElementById("botony-container");
  const svgEl = document.getElementById("botony-svg");
  const svg = d3.select(svgEl);
  const tooltip = document.getElementById("tooltip");
  const statusPill = document.getElementById("status-pill");
  const srStatus = document.getElementById("sr-status");

  if (!container || !svgEl || !tooltip || !statusPill) return;

  const RING_DEFS = (window.AssemblyEngine && AssemblyEngine.RING_DEFS) || {
    1: { title: "Windows core", zone: "Windows Core", accent: "#33506e" },
    2: { title: "Drive space", zone: "Drive Space", accent: "#3d7ea6" },
    3: { title: "User profiles", zone: "User Profile", accent: "#6d5bb0" },
    4: { title: "User subdirectories", zone: "User Subdirectory", accent: "#2f8f7c" },
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;

  let width = 0;
  let height = 0;
  let centerX = 0;
  let centerY = 0;
  let maxRadius = 0;

  let lastData = null;
  let currentGeometry = null;
  let lastSignature = null;
  let currentFocusKey = null;
  let simulationNodes = [];
  let lastNodes = [];

  let hoveredNodeId = null;
  let focusedNodeId = null;
  let hoveredSectorKey = null;
  let lastPointer = { x: 0, y: 0 };
  let tooltipSource = null;
  let connectionState = "connecting";
  let lastStatusKey = "";
  let lastSummary = "";
  let syncTimer = null;
  let resizeFrame = null;

  const containerRect = () => container.getBoundingClientRect();
  const findNode = (id) => simulationNodes.find((node) => node.id === id) || null;
  const findSector = (key) => (currentGeometry ? currentGeometry.sectors.find((sector) => sector.key === key) : null);

  const nodesInRing = (nodes) => {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const node of nodes) counts[node.ring] = (counts[node.ring] || 0) + 1;
    return counts;
  };

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                 */
  /* ---------------------------------------------------------------------- */

  function measure() {
    width = container.clientWidth || window.innerWidth;
    height = container.clientHeight || window.innerHeight;

    const sidePad = Math.max(24, Math.min(width, height) * 0.045);
    const topPad = Math.min(104, Math.max(70, height * 0.105));
    const bottomPad = Math.min(64, Math.max(26, height * 0.06));
    const availableW = Math.max(220, width - sidePad * 2);
    const availableH = Math.max(220, height - topPad - bottomPad);

    maxRadius = Math.max(110, Math.min(availableW, availableH) * 0.5);
    centerX = width / 2;
    centerY = topPad + availableH / 2;
  }

  /* ---------------------------------------------------------------------- */
  /* Layers                                                                 */
  /* ---------------------------------------------------------------------- */

  const gRoot = svg.append("g").attr("class", "botony-root");
  const gTracks = gRoot.append("g").attr("class", "layer-tracks").attr("aria-hidden", "true");
  const gSectors = gRoot.append("g").attr("class", "layer-sectors").attr("aria-hidden", "true");
  const gSpokes = gRoot.append("g").attr("class", "layer-spokes").attr("aria-hidden", "true");
  const gAnnotations = gRoot.append("g").attr("class", "layer-annotations").attr("aria-hidden", "true");
  const gNodes = gRoot.append("g").attr("class", "layer-nodes");

  /* ---------------------------------------------------------------------- */
  /* Zoom & pan                                                             */
  /* ---------------------------------------------------------------------- */

  let zoomTransform = d3.zoomIdentity;
  const zoom = d3
    .zoom()
    .scaleExtent([0.5, 3.5])
    .on("start", () => {
      svgEl.classList.add("is-grabbing");
    })
    .on("zoom", (event) => {
      zoomTransform = event.transform;
      gRoot.attr("transform", zoomTransform);
      if (tooltipSource && tooltipSource.type === "node-focus") {
        const node = findNode(tooltipSource.id);
        if (node) {
          const point = tooltipPointForNode(node);
          positionTooltip(point.x, point.y);
        }
      }
    })
    .on("end", () => {
      svgEl.classList.remove("is-grabbing");
      refreshTooltip();
    });

  svg.call(zoom);
  svg.on("dblclick.zoom", null);
  svg.on("dblclick", () => {
    svg
      .transition()
      .duration(reduceMotion ? 0 : 340)
      .call(zoom.transform, d3.zoomIdentity);
  });

  /* ---------------------------------------------------------------------- */
  /* Simulation                                                             */
  /* ---------------------------------------------------------------------- */

  const simulation = d3
    .forceSimulation([])
    .force(
      "x",
      d3.forceX((d) => d.targetX).strength((d) => (d.level === "dull" ? 0.55 : 0.4)),
    )
    .force(
      "y",
      d3.forceY((d) => d.targetY).strength((d) => (d.level === "dull" ? 0.55 : 0.4)),
    )
    .force(
      "collide",
      d3
        .forceCollide((d) => d.radius + (d.level === "dull" ? 4 : 6))
        .iterations(2),
    )
    .alphaDecay(0.04)
    .on("tick", ticked);

  function ticked() {
    if (!currentGeometry) return;
    const rings = currentGeometry.rings;

    gNodes
      .selectAll("g.app-node")
      .each(function (d) {
        const def = rings[d.ring - 1];
        if (!def) return;

        const dx = d.x - centerX;
        const dy = d.y - centerY;
        const dist = Math.hypot(dx, dy);
        if (!Number.isFinite(dist) || dist === 0) return;
        const ux = dx / dist;
        const uy = dy / dist;

        if (d.ring === 1) {
          // Hard containment: an OS dot can never cross the core boundary.
          const limit = Math.max(def.r1 - Math.max(12, d.radius + 2), 8);
          if (dist > limit) {
            d.x = centerX + ux * limit;
            d.y = centerY + uy * limit;
          }
          return;
        }

        // Keep every outer dot inside its own annular track as well.
        const minR = def.r0 + d.radius + 1;
        const maxR = Math.max(def.r1 - d.radius - 1, minR);
        const contained = Math.min(maxR, Math.max(minR, dist));
        if (Math.abs(contained - dist) > 0.01) {
          d.x = centerX + ux * contained;
          d.y = centerY + uy * contained;
          d.vx *= 0.5;
          d.vy *= 0.5;
        }
      })
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`);
  }

  /* ---------------------------------------------------------------------- */
  /* Sector and ring rendering                                              */
  /* ---------------------------------------------------------------------- */

  const arcGenerator = d3
    .arc()
    .innerRadius((d) => d.innerRadius)
    .outerRadius((d) => d.outerRadius)
    .startAngle((d) => d.startAngle)
    .endAngle((d) => d.endAngle);

  // Last rendered arc shape per path, so accordion tweens interpolate real
  // angles/radii instead of string-patching SVG arc flags (which is invalid).
  const sectorShapes = new WeakMap();
  const sectorShapeOf = (sector) => ({
    startAngle: sector.startAngle,
    endAngle: sector.endAngle,
    innerRadius: sector.innerRadius,
    outerRadius: sector.outerRadius,
  });

  function renderTracks(animate = false) {
    if (!currentGeometry) return;

    const tracks = currentGeometry.rings.map((ring) => ({
      ...ring,
      vacant: !ring.occupied,
    }));

    const selection = gTracks.selectAll("circle.ring-track").data(tracks, (d) => d.ring);
    const enter = selection
      .enter()
      .append("circle")
      .attr("class", (d) => (d.vacant ? "ring-track is-vacant" : "ring-track"))
      .attr("cx", centerX)
      .attr("cy", centerY)
      .attr("r", (d) => d.r1)
      .attr("stroke", (d) => d.stroke);

    const merged = enter.merge(selection);
    merged.attr("class", (d) => (d.vacant ? "ring-track is-vacant" : "ring-track"));

    const apply = (target) =>
      target
        .attr("cx", centerX)
        .attr("cy", centerY)
        .attr("r", (d) => d.r1)
        .attr("stroke", (d) => d.stroke);

    if (animate && !reduceMotion) {
      merged.interrupt().transition().duration(300).ease(d3.easeCubicOut).call(apply);
    } else {
      apply(merged);
    }

    selection.exit().remove();
  }

  function renderSectors(animate = false) {
    if (!currentGeometry) return;

    // d3.arc() draws around the origin; shift the whole sector layer onto the radar.
    gSectors.attr("transform", `translate(${centerX}, ${centerY})`);

    const sectors = currentGeometry.sectors;
    const selection = gSectors.selectAll("path.ring-sector").data(sectors, (d) => d.key);

    const enter = selection
      .enter()
      .append("path")
      .attr("class", (d) => "ring-sector" + (d.focused ? " is-focused" : "") + (d.ring === 1 ? " is-core" : ""))
      .attr("d", (d) => arcGenerator(d))
      .attr("fill", (d) => d.color)
      .attr("stroke", (d) => d.stroke)
      .attr("data-sector", (d) => d.key)
      .style("pointer-events", (d) => (d.ring === 1 || d.appCount === 0 ? "none" : null))
      .on("mouseenter", (event, d) => {
        if (d.ring === 1 || d.appCount === 0) return;
        hoveredSectorKey = d.key;
        lastPointer = pointerFromEvent(event);
        scheduleSync(true);
        refreshTooltip();
      })
      .on("mousemove", (event) => {
        lastPointer = pointerFromEvent(event);
        if (tooltipSource && tooltipSource.type === "sector") positionTooltip(lastPointer.x, lastPointer.y);
      })
      .on("mouseleave", (event, d) => {
        if (hoveredSectorKey === d.key) hoveredSectorKey = null;
        scheduleSync(false);
        refreshTooltip();
      });

    const merged = enter.merge(selection);
    merged
      .attr("class", (d) => "ring-sector" + (d.focused ? " is-focused" : "") + (d.ring === 1 ? " is-core" : ""))
      .attr("data-sector", (d) => d.key)
      .style("pointer-events", (d) => (d.ring === 1 || d.appCount === 0 ? "none" : null));

    const applyStyle = (target) =>
      target.attr("fill", (d) => d.color).attr("stroke", (d) => d.stroke);

    if (animate && !reduceMotion) {
      merged.each(function (d) {
        const path = d3.select(this);
        const next = sectorShapeOf(d);
        const prev = sectorShapes.get(this) || next;
        const iStart = d3.interpolateNumber(prev.startAngle, next.startAngle);
        const iEnd = d3.interpolateNumber(prev.endAngle, next.endAngle);
        const iInner = d3.interpolateNumber(prev.innerRadius, next.innerRadius);
        const iOuter = d3.interpolateNumber(prev.outerRadius, next.outerRadius);

        path
          .interrupt()
          .transition()
          .duration(300)
          .ease(d3.easeCubicOut)
          .attrTween("d", () => (t) => {
            const shape = {
              startAngle: iStart(t),
              endAngle: iEnd(t),
              innerRadius: iInner(t),
              outerRadius: iOuter(t),
            };
            sectorShapes.set(this, shape);
            return arcGenerator(shape);
          });
      });
      applyStyle(merged);
    } else {
      merged.attr("d", (d) => arcGenerator(d));
      merged.each(function (d) {
        sectorShapes.set(this, sectorShapeOf(d));
      });
      applyStyle(merged);
    }

    selection.exit().remove();
  }

  function renderSpokes(animate = false) {
    if (!currentGeometry) return;

    const ringCounts = {};
    for (const sector of currentGeometry.sectors) {
      ringCounts[sector.ring] = (ringCounts[sector.ring] || 0) + 1;
    }

    const spokes = currentGeometry.sectors.filter(
      (sector) => sector.ring > 1 && sector.appCount > 0 && (ringCounts[sector.ring] || 0) > 1,
    );

    const selection = gSpokes.selectAll("line.sector-spoke").data(spokes, (d) => d.key);
    const enter = selection.enter().append("line").attr("class", "sector-spoke");

    const merged = enter.merge(selection);

    const apply = (target) =>
      target
        .attr("x1", (d) => centerX + d.innerRadius * Math.sin(d.startAngle))
        .attr("y1", (d) => centerY - d.innerRadius * Math.cos(d.startAngle))
        .attr("x2", (d) => centerX + d.outerRadius * Math.sin(d.startAngle))
        .attr("y2", (d) => centerY - d.outerRadius * Math.cos(d.startAngle));

    if (animate && !reduceMotion) {
      merged.interrupt().transition().duration(300).ease(d3.easeCubicOut).call(apply);
    } else {
      apply(merged);
    }

    selection.exit().remove();
  }

  function renderAnnotations(animate = false) {
    if (!currentGeometry) return;

    const labels = currentGeometry.sectors.filter((sector) => sector.label && sector.label.visible);

    const selection = gAnnotations.selectAll("g.sector-annotation").data(labels, (d) => d.key);
    const enter = selection
      .enter()
      .append("g")
      .attr("class", (d) => "sector-annotation" + (d.label.outside ? " is-outside" : ""));

    enter.append("line").attr("class", "sector-leader");
    const text = enter.append("text").attr("class", "sector-label");
    text.append("tspan").attr("class", "sector-name");
    text.append("tspan").attr("class", "sector-count").attr("dx", "5");

    const merged = enter.merge(selection);
    merged.attr(
      "class",
      (d) =>
        "sector-annotation" +
        (d.label.outside ? " is-outside" : "") +
        (d.focused ? " is-focused" : ""),
    );

    merged.select("text.sector-label").attr("x", (d) => d.label.x).attr("y", (d) => d.label.y);
    merged.select("tspan.sector-name").text((d) => d.name);
    merged.select("tspan.sector-count").text((d) => String(d.appCount));

    const leaders = merged.select("line.sector-leader");
    leaders.style("display", (d) => (d.label.outside ? null : "none"));
    leaders
      .attr("x1", (d) => centerX + (d.outerRadius + 2) * Math.sin(d.midAngle))
      .attr("y1", (d) => centerY - (d.outerRadius + 2) * Math.cos(d.midAngle))
      .attr("x2", (d) => centerX + (d.outerRadius + 11) * Math.sin(d.midAngle))
      .attr("y2", (d) => centerY - (d.outerRadius + 11) * Math.cos(d.midAngle))
      .attr("stroke", (d) => d.stroke);

    if (animate && !reduceMotion) {
      merged
        .select("text.sector-label")
        .interrupt()
        .transition()
        .duration(300)
        .ease(d3.easeCubicOut)
        .attr("x", (d) => d.label.x)
        .attr("y", (d) => d.label.y);

      leaders
        .interrupt()
        .transition()
        .duration(300)
        .ease(d3.easeCubicOut)
        .attr("x1", (d) => centerX + (d.outerRadius + 2) * Math.sin(d.midAngle))
        .attr("y1", (d) => centerY - (d.outerRadius + 2) * Math.cos(d.midAngle))
        .attr("x2", (d) => centerX + (d.outerRadius + 11) * Math.sin(d.midAngle))
        .attr("y2", (d) => centerY - (d.outerRadius + 11) * Math.cos(d.midAngle));
    }

    selection.exit().remove();
  }

  /* ---------------------------------------------------------------------- */
  /* Node rendering                                                        */
  /* ---------------------------------------------------------------------- */

  function nodeClass(node) {
    const stateClass = node.level === "alarm" ? "beacon-node" : node.level === "file" ? "file-node" : "dull-node";
    return `app-node ${stateClass}${node.isOS ? " os-node" : ""}`;
  }

  function nodeAriaLabel(node) {
    const ring = RING_DEFS[node.ring] || RING_DEFS[2];
    const processCount = node.pids && node.pids.length ? node.pids.length : 1;
    const access = [];
    if (node.micActive) access.push("microphone active");
    if (node.camActive) access.push("camera active");
    if (node.fileReach) access.push("touching personal files");
    return [
      node.app_name,
      node.process_name,
      `${processCount} ${processCount === 1 ? "process" : "processes"}`,
      ring.title,
      node.sectorName,
      access.join(", "),
    ]
      .filter(Boolean)
      .join(", ");
  }

  function renderNodes(nodes, structureChanged = false) {
    simulationNodes = nodes;
    lastNodes = nodes;
    simulation.nodes(simulationNodes);

    const tabbableId =
      focusedNodeId && nodes.some((node) => node.id === focusedNodeId)
        ? focusedNodeId
        : nodes[0] && nodes[0].id;

    const selection = gNodes.selectAll("g.app-node").data(simulationNodes, (d) => d.id);

    const enter = selection
      .enter()
      .append("g")
      .attr("class", nodeClass)
      .attr("data-id", (d) => d.id)
      .attr("data-ring", (d) => d.ring)
      .attr("role", "img")
      .attr("tabindex", (d) => (d.id === tabbableId ? 0 : -1))
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`)
      .attr("aria-label", nodeAriaLabel)
      .on("mouseenter", (event, d) => {
        hoveredNodeId = d.id;
        lastPointer = pointerFromEvent(event);
        scheduleSync(true);
        refreshTooltip();
      })
      .on("mousemove", (event) => {
        lastPointer = pointerFromEvent(event);
        if (tooltipSource && tooltipSource.type === "node-hover") {
          positionTooltip(lastPointer.x, lastPointer.y);
        }
      })
      .on("mouseleave", (event, d) => {
        if (hoveredNodeId === d.id) hoveredNodeId = null;
        scheduleSync(false);
        refreshTooltip();
      })
      .on("focus", (event, d) => {
        focusedNodeId = d.id;
        scheduleSync(true);
        refreshTooltip();
      })
      .on("blur", (event, d) => {
        if (focusedNodeId === d.id) focusedNodeId = null;
        scheduleSync(false);
        refreshTooltip();
      })
      .on("click", (event) => {
        event.stopPropagation();
        const group = event.currentTarget;
        if (document.activeElement === group) {
          group.blur();
        } else if (typeof group.focus === "function") {
          group.focus({ preventScroll: true });
        }
      })
      .on("keydown", handleNodeKeydown);

    enter
      .append("circle")
      .attr("class", "node-pulse-circle")
      .attr("r", (d) => d.radius + 8)
      .style("display", (d) => (d.pulse ? null : "none"));

    enter
      .append("circle")
      .attr("class", "node-circle")
      .attr("r", (d) => d.radius)
      .attr("fill", (d) => d.color)
      .attr("stroke", (d) => d.strokeColor)
      .attr("stroke-width", (d) => (d.isLit ? 2.2 : 1.1));

    const merged = enter.merge(selection);

    merged
      .attr("class", nodeClass)
      .attr("data-id", (d) => d.id)
      .attr("data-ring", (d) => d.ring)
      .attr("tabindex", (d) => (d.id === tabbableId ? 0 : -1))
      .attr("aria-label", nodeAriaLabel);

    merged
      .select("circle.node-circle")
      .attr("r", (d) => d.radius)
      .attr("fill", (d) => d.color)
      .attr("stroke", (d) => d.strokeColor)
      .attr("stroke-width", (d) => (d.isLit ? 2.2 : 1.1));

    merged
      .select("circle.node-pulse-circle")
      .attr("r", (d) => d.radius + 8)
      .style("display", (d) => (d.pulse ? null : "none"));

    selection
      .exit()
      .classed("is-exiting", true)
      .each(function () {
        d3.select(this).select("circle.node-circle").attr("r", 0);
      })
      .transition()
      .duration(reduceMotion ? 0 : 220)
      .style("opacity", 0)
      .remove();

    if (focusedNodeId && !nodes.some((node) => node.id === focusedNodeId)) {
      focusedNodeId = null;
    }
    if (hoveredNodeId && !nodes.some((node) => node.id === hoveredNodeId)) {
      hoveredNodeId = null;
    }

    if (structureChanged) {
      simulation.alpha(Math.max(simulation.alpha(), 0.14)).restart();
    }
  }

  function handleNodeKeydown(event, d) {
    const index = simulationNodes.findIndex((node) => node.id === d.id);
    if (index === -1) return;

    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % simulationNodes.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + simulationNodes.length) % simulationNodes.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = simulationNodes.length - 1;

    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }

    if (nextIndex == null) return;
    event.preventDefault();

    const next = simulationNodes[nextIndex];
    if (!next) return;

    gNodes
      .selectAll("g.app-node")
      .attr("tabindex", (node) => (node.id === next.id ? 0 : -1))
      .filter((node) => node.id === next.id)
      .node()
      ?.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------------- */
  /* Focus / accordion orchestration                                        */
  /* ---------------------------------------------------------------------- */

  function scheduleSync(immediate = false) {
    clearTimeout(syncTimer);
    if (immediate) {
      syncFocus();
    } else {
      syncTimer = setTimeout(syncFocus, 55);
    }
  }

  function syncFocus() {
    if (!lastData || !currentGeometry) return;

    let key = null;
    if (hoveredNodeId) {
      const node = findNode(hoveredNodeId);
      if (node && node.ring > 1) key = node.sectorKey;
    } else if (hoveredSectorKey) {
      key = hoveredSectorKey;
    } else if (focusedNodeId) {
      const node = findNode(focusedNodeId);
      if (node && node.ring > 1) key = node.sectorKey;
    }

    const sector = key ? findSector(key) : null;
    if (!sector || sector.ring === 1 || sector.appCount === 0) key = null;

    if (key === currentFocusKey) return;
    if (!key) {
      unfocusSector();
      return;
    }
    focusSector(key);
  }

  /** Keep the dot under the pointer still while its sector swells around it. */
  function pinActiveNode() {
    const node =
      (hoveredNodeId && findNode(hoveredNodeId)) || (focusedNodeId && findNode(focusedNodeId)) || null;
    if (!node) return;
    node.targetX = node.x;
    node.targetY = node.y;
  }

  function focusSector(key) {
    if (!lastData || !currentGeometry) return;
    const sector = findSector(key);
    if (!sector || sector.ring === 1 || sector.appCount === 0) return;
    if (currentFocusKey === key) return;

    currentFocusKey = key;
    currentGeometry = engine.computeSunburstGeometry(
      lastData.apps,
      lastData.skeleton,
      centerX,
      centerY,
      maxRadius,
      currentFocusKey,
    );
    lastSignature = currentGeometry.signature;

    renderSectors(true);
    renderSpokes(true);
    renderAnnotations(true);

    const moved = engine.retargetNodes(simulationNodes, centerX, centerY, maxRadius);
    pinActiveNode();
    if (moved) simulation.alpha(0.2).restart();
    refreshTooltip();
  }

  function unfocusSector() {
    if (!lastData || !currentGeometry || !currentFocusKey) return;

    currentFocusKey = null;
    currentGeometry = engine.computeSunburstGeometry(
      lastData.apps,
      lastData.skeleton,
      centerX,
      centerY,
      maxRadius,
      null,
    );
    lastSignature = currentGeometry.signature;

    renderSectors(true);
    renderSpokes(true);
    renderAnnotations(true);

    const moved = engine.retargetNodes(simulationNodes, centerX, centerY, maxRadius);
    if (moved) simulation.alpha(0.2).restart();
    refreshTooltip();
  }

  /* ---------------------------------------------------------------------- */
  /* HUD tooltip                                                             */
  /* ---------------------------------------------------------------------- */

  const escapeHtml = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
      const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return map[char];
    });

  function pointerFromEvent(event) {
    const rect = containerRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function ringMeter(ring) {
    return `<span class="hud-meter" aria-hidden="true">${[1, 2, 3, 4]
      .map((index) => `<i class="${index === ring ? "is-on" : ""}"></i>`)
      .join("")}</span>`;
  }

  function nodeTooltipHtml(node) {
    const ring = RING_DEFS[node.ring] || RING_DEFS[2];
    const pids = Array.from(new Set((node.pids || []).filter(Boolean)));
    const primaryPid = node.pid || pids[0];
    const extraPids = primaryPid ? pids.filter((pid) => pid !== primaryPid).length : 0;
    const processCount = Math.max(pids.length, 1);
    const keys = Array.from(
      new Set(
        ((node.spatial && node.spatial.location_keys) || (node.spatial && node.spatial.sector_path) || []).filter(
          Boolean,
        ),
      ),
    ).slice(0, 4);

    const badges = [];
    if (node.micActive) badges.push(`<span class="hud-badge is-mic"><i></i>Microphone live</span>`);
    if (node.camActive) badges.push(`<span class="hud-badge is-cam"><i></i>Camera live</span>`);
    if (node.fileReach) badges.push(`<span class="hud-badge is-file"><i></i>Touching personal files</span>`);
    if (!badges.length && node.ring === 1) badges.push(`<span class="hud-badge is-core"><i></i>OS core service</span>`);

    const active = node.micActive || node.camActive;

    return `
      <div class="hud-accent"></div>
      <div class="hud-body">
        <div class="hud-title-row">
          <span class="hud-title">${escapeHtml(node.app_name || node.process_name)}</span>
          ${active ? `<span class="hud-live">live</span>` : ""}
        </div>
        <div class="hud-sub">${escapeHtml(node.process_name || "unknown process")}${
          processCount > 1 ? `<span class="hud-dim"> / </span>${processCount} processes` : ""
        }</div>
        <div class="hud-location">
          ${ringMeter(node.ring)}
          <span class="hud-ring-name">${escapeHtml(ring.title)}</span>
          <span class="hud-sector-name">${escapeHtml(node.sectorName || "")}</span>
        </div>
        <dl class="hud-data">
          <div class="hud-row">
            <dt>PID</dt>
            <dd>${primaryPid || "—"}${extraPids > 0 ? `<span class="hud-more">+${extraPids}</span>` : ""}</dd>
          </div>
          <div class="hud-row">
            <dt>Path</dt>
            <dd class="hud-path">${escapeHtml(node.path || "No executable path")}</dd>
          </div>
        </dl>
        ${
          keys.length
            ? `<div class="hud-keys">${keys
                .map((key) => `<span class="key-pill">${escapeHtml(key)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${badges.length ? `<div class="hud-badges">${badges.join("")}</div>` : ""}
      </div>
    `;
  }

  function sectorTooltipHtml(sector) {
    const ring = RING_DEFS[sector.ring] || RING_DEFS[2];
    const preview = (sector.appsPreview || []).filter(Boolean);
    const hiddenCount = Math.max((sector.appCount || 0) - preview.length, 0);
    const previewText = preview.length
      ? `${preview.map(escapeHtml).join(", ")}${hiddenCount > 0 ? ` and ${hiddenCount} more` : ""}`
      : "No applications in this sector";

    return `
      <div class="hud-accent"></div>
      <div class="hud-body">
        <div class="hud-title-row">
          <span class="hud-title">${escapeHtml(sector.name)}</span>
          <span class="hud-count">${sector.appCount} ${sector.appCount === 1 ? "app" : "apps"}</span>
        </div>
        <div class="hud-location">
          ${ringMeter(sector.ring)}
          <span class="hud-ring-name">${escapeHtml(ring.title)}</span>
        </div>
        <p class="hud-preview">${previewText}</p>
        <p class="hud-hint">Hover a dot for process details.</p>
      </div>
    `;
  }

  function tooltipPointForNode(node) {
    return {
      x: zoomTransform.applyX(node.x),
      y: zoomTransform.applyY(node.y),
    };
  }

  function showTooltip(html, ring, source, point) {
    tooltip.innerHTML = html;
    tooltip.dataset.ring = String(ring);
    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");
    tooltipSource = source;
    positionTooltip(point.x, point.y);
  }

  function positionTooltip(x, y) {
    const pad = 14;
    const gap = 16;
    const tooltipW = tooltip.offsetWidth;
    const tooltipH = tooltip.offsetHeight;
    let left = x + gap;
    let top = y + gap;

    if (left + tooltipW > width - pad) left = x - tooltipW - gap;
    if (top + tooltipH > height - pad) top = y - tooltipH - gap;

    left = Math.min(Math.max(left, pad), Math.max(pad, width - tooltipW - pad));
    top = Math.min(Math.max(top, pad), Math.max(pad, height - tooltipH - pad));

    tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function hideTooltip() {
    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
    tooltipSource = null;
  }

  function refreshTooltip() {
    if (hoveredNodeId) {
      const node = findNode(hoveredNodeId);
      if (node) {
        showTooltip(
          nodeTooltipHtml(node),
          node.ring,
          { type: "node-hover", id: node.id },
          lastPointer,
        );
        return;
      }
    }

    if (focusedNodeId) {
      const node = findNode(focusedNodeId);
      if (node) {
        showTooltip(
          nodeTooltipHtml(node),
          node.ring,
          { type: "node-focus", id: node.id },
          tooltipPointForNode(node),
        );
        return;
      }
    }

    if (hoveredSectorKey) {
      const sector = findSector(hoveredSectorKey);
      if (sector) {
        showTooltip(
          sectorTooltipHtml(sector),
          sector.ring,
          { type: "sector", key: sector.key },
          lastPointer,
        );
        return;
      }
    }

    hideTooltip();
  }

  /* ---------------------------------------------------------------------- */
  /* Status HUD & screen-reader summary                                     */
  /* ---------------------------------------------------------------------- */

  function renderStatus(nodes) {
    const counts = nodesInRing(nodes);
    const userApps = counts[2] + counts[3] + counts[4];
    const micApps = nodes.filter((node) => node.micActive).map((node) => node.app_name);
    const camApps = nodes.filter((node) => node.camActive).map((node) => node.app_name);
    const live = connectionState === "live";
    const offline = connectionState === "offline";

    let html = `
      <span class="status-led" aria-hidden="true"></span>
      <span class="status-brand">Observatory</span>
      <span class="status-word">${live ? "live" : offline ? "offline" : "connecting"}</span>
    `;

    if (live) {
      html += `
        <span class="status-rule" aria-hidden="true"></span>
        <span class="status-stat"><b>${userApps}</b> user ${userApps === 1 ? "app" : "apps"}</span>
        <span class="status-stat"><b>${counts[1]}</b> core</span>
      `;

      if (micApps.length || camApps.length) {
        const label =
          micApps.length && camApps.length
            ? "mic + camera live"
            : micApps.length
              ? "microphone live"
              : "camera live";
        html += `<span class="status-alert"><span class="status-led" aria-hidden="true"></span>${label}</span>`;
      }
    } else if (offline) {
      html += `<span class="status-rule" aria-hidden="true"></span><span class="status-stat">collector.json unreachable</span>`;
    }

    const statusKey = `${connectionState}|${nodes.length}|${counts[1]}|${counts[2]}|${counts[3]}|${counts[4]}|${micApps.length}|${camApps.length}`;
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey;
      statusPill.innerHTML = html;
    }
    statusPill.dataset.state = connectionState;

    const scanTime = (lastData && lastData.meta && lastData.meta.scan_time) || "";
    statusPill.title = scanTime
      ? `Scan ${scanTime}. Updates every 1.5 seconds.`
      : "Updates every 1.5 seconds.";

    const micNames = micApps.slice(0, 3).join(", ");
    const camNames = camApps.slice(0, 3).join(", ");
    const summary = [
      `${nodes.length} running applications.`,
      `${counts[1]} Windows core, ${counts[2]} drive space, ${counts[3]} user profiles, ${counts[4]} user subdirectories.`,
      micNames ? `Microphone active in ${micNames}.` : "",
      camNames ? `Camera active in ${camNames}.` : "",
      offline ? "Collector offline; showing the last scan." : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (summary !== lastSummary) {
      lastSummary = summary;
      if (srStatus) srStatus.textContent = summary;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Data updates                                                           */
  /* ---------------------------------------------------------------------- */

  const engine = new AssemblyEngine({
    collectorUrl: "../collector.json",
    refreshInterval: 1500,
  });

  engine.onStatus((status) => {
    connectionState = status.state;
    renderStatus(lastNodes);
  });

  engine.onUpdate((data) => {
    const firstPayload = lastData === null;
    lastData = data;

    let geometry = engine.computeSunburstGeometry(
      data.apps,
      data.skeleton,
      centerX,
      centerY,
      maxRadius,
      currentFocusKey,
    );

    // A focused folder can disappear when its last app closes.
    if (currentFocusKey && !geometry.sectors.some((sector) => sector.key === currentFocusKey)) {
      currentFocusKey = null;
      geometry = engine.computeSunburstGeometry(
        data.apps,
        data.skeleton,
        centerX,
        centerY,
        maxRadius,
        null,
      );
    }

    if (hoveredSectorKey && !geometry.sectors.some((sector) => sector.key === hoveredSectorKey)) {
      hoveredSectorKey = null;
    }

    const signatureChanged = geometry.signature !== lastSignature;
    currentGeometry = geometry;

    if (signatureChanged) {
      lastSignature = geometry.signature;
      const animate = signatureChanged && !firstPayload;
      renderTracks(animate);
      renderSectors(animate);
      renderSpokes(animate);
      renderAnnotations(animate);
    }

    const result = engine.processAppNodes(data.apps, centerX, centerY, maxRadius);
    renderNodes(result.nodes, result.structureChanged);
    pinActiveNode();
    renderStatus(result.nodes);
    refreshTooltip();
  });

  /* ---------------------------------------------------------------------- */
  /* Boot                                                                   */
  /* ---------------------------------------------------------------------- */

  measure();

  // Paint the instrument before the first collector response so an empty or
  // offline daemon still reads as a radar rather than a blank page.
  currentGeometry = engine.computeSunburstGeometry([], {}, centerX, centerY, maxRadius, null);
  lastSignature = currentGeometry.signature;
  renderTracks(false);
  renderSectors(false);
  renderSpokes(false);
  renderAnnotations(false);

  engine.startPolling();

  /* ---------------------------------------------------------------------- */
  /* Resize                                                                 */
  /* ---------------------------------------------------------------------- */

  window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      measure();
      if (!lastData) return;

      currentGeometry = engine.computeSunburstGeometry(
        lastData.apps,
        lastData.skeleton,
        centerX,
        centerY,
        maxRadius,
        currentFocusKey,
      );
      lastSignature = currentGeometry.signature;

      renderTracks(false);
      renderSectors(false);
      renderSpokes(false);
      renderAnnotations(false);

      engine.retargetNodes(simulationNodes, centerX, centerY, maxRadius);
      simulation.alpha(0.26).restart();
      refreshTooltip();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Keyboard escape & debug handle                                         */
  /* ---------------------------------------------------------------------- */

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const active = document.activeElement;
    if (active && active.closest && active.closest("g.app-node")) {
      active.blur();
    }
    hoveredSectorKey = null;
    hideTooltip();
  });

  svg.on("click", (event) => {
    const target = event.target;
    if (target && target.closest && target.closest("g.app-node")) return;
    focusedNodeId = null;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest("g.app-node")) {
      document.activeElement.blur();
    }
    scheduleSync(false);
    refreshTooltip();
  });

  if (new URLSearchParams(window.location.search).has("debug")) {
    window.__observatory = {
      get data() {
        return lastData;
      },
      get geometry() {
        return currentGeometry;
      },
      get focusKey() {
        return currentFocusKey;
      },
      get zoomTransform() {
        return zoomTransform;
      },
      get nodes() {
        return simulationNodes;
      },
      focusSector,
      pause: () => engine.stopPolling(),
      resume: () => engine.startPolling(),
      resetZoom: () =>
        svg
          .transition()
          .duration(reduceMotion ? 0 : 340)
          .call(zoom.transform, d3.zoomIdentity),
      simulateAccess(appName, kind = "microphone") {
        if (!lastData) return false;
        const snapshot = JSON.parse(JSON.stringify(lastData));
        const app = (snapshot.apps || []).find(
          (entry) => String(entry.app_name || "").toLowerCase() === String(appName || "").toLowerCase(),
        );
        if (!app) return false;
        if (kind === "camera") {
          app.webcam = { ...(app.webcam || {}), active: true };
        } else {
          app.microphone = { ...(app.microphone || {}), active: true };
        }
        engine.notifyListeners(snapshot);
        return true;
      },
    };
  }
});
