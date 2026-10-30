// ==UserScript==
// @name         AWBW Threat Overlay
// @namespace    awbw-threat-overlay
// @version      1.1.0
// @description  Highlights every tile that visible enemy units could attack on their next turn (move + fire for direct units, current range for indirect units) on Advance Wars By Web.
// @homepageURL  https://github.com/ctrlc03/awbw-assist
// @supportURL   https://github.com/ctrlc03/awbw-assist/issues
// @updateURL    https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-threat-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-threat-overlay.user.js
// @match        https://awbw.amarriner.com/game.php*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

(function () {
  "use strict";

  if (!document.getElementById("gamemap")) return;

  const LOG = "[AWBW threat overlay]";
  const LS = "awbw-to:";
  const TILE = 16; // px per map tile (game.js: unit spans are left = x * 16, top = y * 16)
  const GAME_ID = +new URLSearchParams(location.search).get("games_id") || 0;

  // Defender classes, as a bitmask. Derived from units_movement_type:
  // A = air; S (ship) and L (lander) = sea; F, B, T, W, P (foot, boots, treads, wheels, pipe) = ground.
  const CLASS_GROUND = 1;
  const CLASS_AIR = 2;
  const CLASS_SEA = 4;
  const classOfMoveType = (t) => (t === "A" ? CLASS_AIR : t === "S" || t === "L" ? CLASS_SEA : CLASS_GROUND);
  const FILTERS = { "": 0, ground: CLASS_GROUND, air: CLASS_AIR, sea: CLASS_SEA };

  // Black Bomb: game.js explodeUnit -> damageUnitsInRangeOf(3, -5, x, y); the explode menu draws createSquareInRangeOf(3, 0, ...).
  const BOMB_RADIUS = 3;

  // ---------------------------------------------------------------------------
  // Page access. Inline game.php globals are let/const (reachable by bare name, not window properties),
  // and can sit in the temporal dead zone while the page boots, so every read happens inside try/catch.
  // ---------------------------------------------------------------------------

  function page() {
    try {
      /* eslint-disable no-undef */
      const dsOlaf = typeof GAME_FLAGS__JJ__DS_OLAF !== "undefined" && Boolean(GAME_FLAGS__JJ__DS_OLAF);
      return {
        units: unitsInfo,
        players: playersInfo,
        generic: genericUnits,
        mx: maxX,
        my: maxY,
        weather: gameWeather,
        turn: currentTurn,
        viewer: typeof viewerPId === "undefined" ? 0 : viewerPId,
        dsOlaf,
        dmg: window.baseDamageValues,
        getMovementTiles: window.getMovementTiles,
      };
      /* eslint-enable no-undef */
    } catch (_) {
      return null;
    }
  }

  const ready = (g) =>
    g && g.units && g.players && g.generic && g.mx > 0 && g.my > 0 && g.weather && g.dmg && g.dmg.ATTACK1 && g.dmg.ATTACK2 && typeof g.getMovementTiles === "function";

  // ---------------------------------------------------------------------------
  // Threat computation (pure with respect to the DOM)
  // ---------------------------------------------------------------------------

  const maskCache = new Map();

  // Which defender classes can this unit damage? Mirrors game.js findUnitsInRangeOf: a defender is attackable if
  // ATTACK2 (secondary weapon, no ammo) has an entry, or ATTACK1 (primary, needs ammo) has one and ammo is not 0.
  function damageMask(g, unit, genId) {
    const noAmmo = unit.units_ammo != null && Number(unit.units_ammo) === 0;
    const key = genId + (noAmmo ? "z" : "a");
    const cached = maskCache.get(key);
    if (cached != null) return cached;
    const a1 = g.dmg.ATTACK1[genId];
    const a2 = g.dmg.ATTACK2[genId];
    let mask = 0;
    for (const name in g.generic) {
      const d = g.generic[name];
      if ((a2 && a2[d.units_id]) || (a1 && a1[d.units_id] && !noAmmo)) mask |= classOfMoveType(d.units_movement_type);
    }
    maskCache.set(key, mask);
    return mask;
  }

  // Movement points exactly as game.js unitClickHandler computes them (fuel cap, DS snow halves fuel use).
  function movePoints(g, unit, owner) {
    let mp = Number(unit.units_movement_points);
    const fuel = Number(unit.units_fuel);
    const code = g.weather.code;
    const isDsSnow = code === "2" || code === "1" || (g.dsOlaf && code === "S");
    const isOlaf = owner && owner.co_name === "Olaf";
    if (!Number.isFinite(fuel)) return mp;
    if (isDsSnow && !isOlaf) mp = Math.min(mp, Math.floor(fuel / 2));
    else if (fuel < mp) mp = fuel;
    return mp;
  }

  const offsetCache = new Map();
  function ringOffsets(rmin, rmax) {
    const key = rmin + ":" + rmax;
    let o = offsetCache.get(key);
    if (!o) {
      o = [];
      for (let dx = -rmax; dx <= rmax; dx++) {
        for (let dy = -rmax; dy <= rmax; dy++) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d >= rmin && d <= rmax) o.push(dx, dy);
        }
      }
      offsetCache.set(key, o);
    }
    return o;
  }

  // Tiles the unit could land on next turn, via the page's own pathfinder (draw=false: no DOM side effects).
  function landingTiles(g, unit, owner, mp) {
    const info = g.getMovementTiles(
      g.mx,
      g.my,
      unit.units_movement_type,
      mp,
      { x: +unit.units_x, y: +unit.units_y },
      owner.players_team,
      owner,
      false
    );
    return info.tilesToDraw;
  }

  // -> { threats: [...], counts: Uint16Array, lists: Array<number[]|undefined>, enemyUnits, unarmed, errors }
  function computeThreats(persp) {
    const g = page();
    if (!ready(g)) return null;
    const me = g.players[persp];
    if (!me) return null;
    const perspTeam = String(me.players_team);
    const mx = g.mx;
    const my = g.my;
    const n = mx * my;
    const threats = [];
    let enemyUnits = 0;
    let unarmed = 0;
    let errors = 0;

    // getMovementTiles reads the page's `currentClick` (the unit the viewer has selected) to also look for attackable
    // units; that work is wasted here (and costly per call), so hide the selection for the duration of this synchronous loop.
    const savedClick = window.currentClick;
    if (savedClick) window.currentClick = null;
    try {
      for (const id in g.units) {
        const u = g.units[id];
        if (!u || u.units_carried === "Y") continue;
        const x = +u.units_x;
        const y = +u.units_y;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= mx || y >= my) continue;
        const owner = g.players[u.units_players_id];
        if (!owner || String(owner.players_team) === perspTeam) continue;
        if (owner.players_eliminated === "Y") continue;
        enemyUnits++;
        const gen = g.generic[u.units_name];
        if (!gen) continue;
        const isBomb = u.units_name === "Black Bomb";
        const mask = isBomb ? CLASS_GROUND | CLASS_AIR | CLASS_SEA : damageMask(g, u, gen.units_id);
        if (!mask) {
          unarmed++;
          continue;
        }
        try {
          const short = Number(u.units_short_range) || 0;
          const long = Number(u.units_long_range) || 0;
          const indirect = !isBomb && short > 1;
          let origins;
          let rmin;
          let rmax;
          let kind;
          let mp = 0;
          if (indirect) {
            // Cannot move and fire: only the current position matters.
            origins = [{ x, y }];
            rmin = short;
            rmax = long;
            kind = "indirect";
          } else {
            mp = movePoints(g, u, owner);
            origins = landingTiles(g, u, owner, mp);
            if (isBomb) {
              rmin = 0;
              rmax = BOMB_RADIUS;
              kind = "bomb";
            } else {
              rmin = 1;
              rmax = short <= 0 ? 1 : long; // game.js: range 0/0 means adjacent only
              kind = "direct";
            }
          }
          const offs = ringOffsets(rmin, rmax);
          const mark = new Uint8Array(n);
          let hits = 0;
          for (const o of origins) {
            for (let k = 0; k < offs.length; k += 2) {
              const tx = o.x + offs[k];
              const ty = o.y + offs[k + 1];
              if (tx < 0 || ty < 0 || tx >= mx || ty >= my) continue;
              const idx = ty * mx + tx;
              if (!mark[idx]) {
                mark[idx] = 1;
                hits++;
              }
            }
          }
          const tiles = new Int32Array(hits);
          for (let i = 0, w = 0; i < n; i++) if (mark[i]) tiles[w++] = i;
          threats.push({
            id: +u.units_id,
            name: u.units_name,
            pid: +u.units_players_id,
            owner: owner.users_username || "?",
            hp: u.units_hit_points,
            x,
            y,
            kind,
            rmin,
            rmax,
            mp,
            landings: indirect ? 1 : origins.length,
            mask,
            tiles,
          });
        } catch (err) {
          errors++;
          console.warn(LOG, "could not compute unit", id, err);
        }
      }
    } finally {
      if (savedClick) window.currentClick = savedClick;
    }
    return { threats, enemyUnits, unarmed, errors, mx, my, perspTeam, weatherCode: g.weather.code };
  }

  // Applies the class filter and sums per-tile counts. -> { counts, lists, tiles, max, units }
  function aggregate(res, classMask) {
    const n = res.mx * res.my;
    const counts = new Uint16Array(n);
    const lists = new Array(n);
    let tiles = 0;
    let max = 0;
    let units = 0;
    res.threats.forEach((t, ti) => {
      if (classMask && !(t.mask & classMask)) return;
      units++;
      for (let i = 0; i < t.tiles.length; i++) {
        const idx = t.tiles[i];
        if (!counts[idx]++) {
          tiles++;
          lists[idx] = [ti];
        } else lists[idx].push(ti);
        if (counts[idx] > max) max = counts[idx];
      }
    });
    return { counts, lists, tiles, max, units };
  }

  // ---- AWBW assist panel frame v1 ---------------------------------------------------------
  // Identical copy in every AWBW assist userscript (they are installed independently).
  // Shared dock on the right; each panel can be dragged by its header (position remembered),
  // re-docked with ↺, and switched off with ⏻ (state remembered).
  const AWBW_PANEL_ORDER = ["kt", "to", "cp", "ct", "fm"];

  function awbwAssistDock() {
    if (!document.getElementById("awbw-assist-style")) {
      const st = document.createElement("style");
      st.id = "awbw-assist-style";
      st.textContent = `
  #awbw-assist-dock{position:fixed;right:12px;bottom:12px;z-index:100000;display:flex;flex-direction:column;gap:6px;
    width:420px;max-height:calc(100vh - 24px);overflow-y:auto;pointer-events:none}
  #awbw-assist-dock>*{flex-shrink:0;pointer-events:auto;position:relative!important;left:auto!important;top:auto!important;
    right:auto!important;bottom:auto!important;width:auto!important;box-sizing:border-box}
  .awbw-floating{position:fixed!important;right:auto!important;bottom:auto!important;z-index:100001!important;box-sizing:border-box}
  .awbw-dragging{opacity:.85;user-select:none}
  .awbw-drag-handle{cursor:move}
  .awbw-hbtn{background:none;border:0;color:inherit;font:bold 12px/1 Verdana,sans-serif;cursor:pointer;padding:0 2px;opacity:.8}
  .awbw-hbtn:hover{opacity:1}
  .awbw-off>:not(.awbw-drag-handle){display:none!important}
  .awbw-off .awbw-drag-handle{background:#777!important}`;
      document.head.appendChild(st);
    }
    let dock = document.getElementById("awbw-assist-dock");
    if (!dock) {
      dock = document.createElement("div");
      dock.id = "awbw-assist-dock";
      document.body.appendChild(dock);
    }
    return dock;
  }

  // panel: root element; header: its first child (drag handle). The script's own click-to-collapse on
  // the header keeps working; clicks that end a drag and clicks on the frame buttons never reach it.
  // onEnabled(bool) is called once at mount and on every ⏻ toggle.
  function awbwMountPanel({ key, panel, header, onEnabled }) {
    const POS = "awbw-assist:pos:" + key;
    const ON = "awbw-assist:on:" + key;
    const dock = awbwAssistDock();
    const order = AWBW_PANEL_ORDER.indexOf(key);
    panel.dataset.awbwOrder = String(order < 0 ? 99 : order);
    header.classList.add("awbw-drag-handle");

    const power = document.createElement("button");
    power.className = "awbw-hbtn";
    const redock = document.createElement("button");
    redock.className = "awbw-hbtn";
    redock.textContent = "↺";
    redock.title = "Put back in the dock";
    header.insertBefore(redock, header.firstChild);
    header.insertBefore(power, header.firstChild);

    let enabled = localStorage.getItem(ON) !== "0";
    const paintPower = () => {
      power.textContent = "⏻";
      power.title = enabled ? "Switch this plugin off" : "Switch this plugin on";
      power.style.color = enabled ? "#7CFC9A" : "#ddd";
      panel.classList.toggle("awbw-off", !enabled);
    };

    const toDock = () => {
      panel.classList.remove("awbw-floating");
      panel.style.left = panel.style.top = panel.style.width = "";
      const after = [...dock.children].find((c) => +c.dataset.awbwOrder > +panel.dataset.awbwOrder);
      dock.insertBefore(panel, after || null);
      redock.style.display = "none";
    };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const place = (left, top) => {
      panel.style.left = clamp(left, 0, Math.max(0, innerWidth - panel.offsetWidth)) + "px";
      panel.style.top = clamp(top, 0, Math.max(0, innerHeight - header.offsetHeight)) + "px";
    };
    const toFloat = (left, top, width) => {
      if (panel.parentElement !== document.body) document.body.appendChild(panel);
      panel.classList.add("awbw-floating");
      panel.style.width = width + "px";
      place(left, top);
      redock.style.display = "";
    };

    try {
      const saved = JSON.parse(localStorage.getItem(POS) || "null");
      if (saved) toFloat(saved.left, saved.top, saved.width);
      else toDock();
    } catch (_) {
      toDock();
    }
    addEventListener("resize", () => {
      if (panel.classList.contains("awbw-floating")) place(panel.offsetLeft, panel.offsetTop);
    });

    let swallowClick = false;
    header.addEventListener(
      "click",
      (e) => {
        if (swallowClick) e.stopImmediatePropagation();
        swallowClick = false;
      },
      true
    );
    power.addEventListener("click", (e) => {
      e.stopPropagation(); // not a collapse click
      enabled = !enabled;
      localStorage.setItem(ON, enabled ? "1" : "0");
      paintPower();
      onEnabled(enabled);
    });
    redock.addEventListener("click", (e) => {
      e.stopPropagation();
      localStorage.removeItem(POS);
      toDock();
    });

    header.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button,input,select,label,a")) return;
      const r = panel.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      let dragging = false;
      const move = (ev) => {
        if (!dragging) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
          dragging = true;
          toFloat(r.left, r.top, r.width);
          panel.classList.add("awbw-dragging");
        }
        place(r.left + ev.clientX - sx, r.top + ev.clientY - sy);
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        if (!dragging) return;
        panel.classList.remove("awbw-dragging");
        swallowClick = true;
        setTimeout(() => (swallowClick = false), 0);
        localStorage.setItem(POS, JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth }));
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });

    paintPower();
    onEnabled(enabled);
    return { isEnabled: () => enabled };
  }
  // ---- end AWBW assist panel frame ----------------------------------------------------------

  // ---------------------------------------------------------------------------
  // State + UI
  // ---------------------------------------------------------------------------

  const store = {
    get: (k, d) => {
      try {
        const v = localStorage.getItem(LS + k);
        return v == null ? d : v;
      } catch (_) {
        return d;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(LS + k, v);
      } catch (_) {}
    },
  };

  const ui = {
    enabled: true, // master switch, owned by the shared panel frame (⏻)
    mode: store.get("mode", "hover") === "always" ? "always" : "hover",
    min: store.get("min", "0") === "1",
    counts: store.get("counts", "0") === "1",
    filter: FILTERS[store.get("filter", "")] != null ? store.get("filter", "") : "",
    persp: 0,
    panel: null,
    canvas: null,
    hover: null,
    tip: null,
    over: null, // id of the unit under the mouse
    inMap: false,
    shift: false,
    full: false, // true while the all-enemies view is painted
  };
  const state = { res: null, agg: null, byId: new Map(), fingerprint: "", waiting: false };

  const css = `
  #to-panel{box-sizing:border-box;flex:none;display:flex;flex-direction:column;background:#fff;color:#222;border:1px solid #888;border-radius:6px;
    box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px Verdana,sans-serif}
  #to-panel .to-head{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#2c3e66;color:#fff;border-radius:5px 5px 0 0;cursor:pointer;user-select:none}
  #to-panel.to-min .to-head{border-radius:5px}
  #to-panel .to-title{font-weight:bold;flex:1}
  #to-panel .to-status{font-size:10px;opacity:.85}
  #to-panel .to-body{display:flex;flex-direction:column;gap:5px;padding:6px 8px}
  #to-panel.to-min .to-body{display:none}
  #to-panel .to-row{display:flex;align-items:center;gap:6px}
  #to-panel .to-row>span{width:74px;flex:none}
  #to-panel select{flex:1;min-width:0;font-size:11px}
  #to-panel .to-sum{font-size:11px;color:#333;line-height:1.35}
  #to-panel .to-legend{display:flex;align-items:center;gap:3px;font-size:10px;color:#555}
  #to-panel .to-sw{display:inline-block;width:16px;height:12px;border:1px solid rgba(0,0,0,.35);text-align:center;font:bold 9px/12px Verdana,sans-serif;color:#fff}
  #to-panel .to-note{font-size:10px;color:#777;line-height:1.3}
  #to-canvas{position:absolute;left:0;top:0;pointer-events:none;z-index:120}
  #to-hover{position:absolute;box-sizing:border-box;width:16px;height:16px;border:1px solid #fff;outline:1px solid #000;pointer-events:none;z-index:121;display:none}
  #to-tip{position:fixed;z-index:100001;background:rgba(20,24,40,.94);color:#fff;font:11px/1.35 Verdana,sans-serif;padding:5px 8px;border-radius:4px;
    pointer-events:none;display:none;max-width:340px}
  #to-tip b{color:#ffb3b3}
  #to-tip small{color:#b8c2dc}
  `;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // Alpha ramp by number of threatening units (index = count, capped).
  const ALPHA = [0, 0.2, 0.32, 0.43, 0.53, 0.62];
  const alphaFor = (n) => ALPHA[Math.min(n, ALPHA.length - 1)];

  function buildUI() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const p = document.createElement("div");
    p.id = "to-panel";
    if (ui.min) p.classList.add("to-min");
    p.innerHTML = `
      <div class="to-head"><span class="to-title">Threat overlay</span><span class="to-status"></span><span class="to-arrow"></span></div>
      <div class="to-body">
        <div class="to-row"><span>Display</span><select class="to-mode" title="Hover: paint only the unit under the mouse (hold Shift for every enemy). Always: paint every enemy.">
          <option value="hover">Hover (Shift = all)</option><option value="always">Always (all enemies)</option></select></div>
        <div class="to-row"><span>Enemies of</span><select class="to-persp" title="Every team other than this player's is treated as the enemy"></select></div>
        <div class="to-row"><span>Can hit</span><select class="to-filter" title="Only count enemy units that can damage this class of unit (from the game's damage tables). Applies to the all-enemies view.">
          <option value="">any unit</option><option value="ground">ground units</option><option value="air">air units</option><option value="sea">sea units</option></select></div>
        <label><input type="checkbox" class="to-counts"> show threat count on tiles</label>
        <div class="to-sum"></div>
        <div class="to-legend"></div>
        <div class="to-note">Hover an enemy unit to see the tiles it can attack next turn; hold Shift for all enemies, then hover a tile for the units threatening it. Direct units: move + attack. Indirect units: current position only.</div>
      </div>`;
    ui.panel = p;

    const arrow = p.querySelector(".to-arrow");
    const setArrow = () => (arrow.textContent = ui.min ? "▴" : "▾");
    setArrow();
    p.querySelector(".to-head").addEventListener("click", () => {
      ui.min = !ui.min;
      p.classList.toggle("to-min", ui.min);
      store.set("min", ui.min ? "1" : "0");
      setArrow();
    });

    const mode = p.querySelector(".to-mode");
    mode.value = ui.mode;
    mode.addEventListener("change", () => {
      ui.mode = mode.value === "always" ? "always" : "hover";
      store.set("mode", ui.mode);
      render();
    });
    const counts = p.querySelector(".to-counts");
    counts.checked = ui.counts;
    counts.addEventListener("change", () => {
      ui.counts = counts.checked;
      store.set("counts", ui.counts ? "1" : "0");
      render();
    });
    const filter = p.querySelector(".to-filter");
    filter.value = ui.filter;
    filter.addEventListener("change", () => {
      ui.filter = filter.value;
      store.set("filter", ui.filter);
      applyFilter();
    });
    p.querySelector(".to-persp").addEventListener("change", (e) => {
      ui.persp = +e.target.value;
      store.set("persp:" + GAME_ID, String(ui.persp));
      recompute(true);
    });

    const legend = p.querySelector(".to-legend");
    legend.innerHTML =
      "<span>units:</span>" +
      [1, 2, 3, 4, 5].map((n) => `<span class="to-sw" style="background:rgba(230,30,30,${alphaFor(n)})">${n === 5 ? "5+" : n}</span>`).join("") +
      "<span>= enemy units that can hit the tile</span>";

    // Tooltip + hover marker. Everything is pointer-events:none; the map's own mousemove drives the tooltip.
    ui.tip = document.createElement("div");
    ui.tip.id = "to-tip";
    document.body.appendChild(ui.tip);
    const map = document.getElementById("gamemap");
    ui.hover = document.createElement("div");
    ui.hover.id = "to-hover";
    map.appendChild(ui.hover);
    map.addEventListener("mousemove", onMapMove);
    map.addEventListener("mouseleave", onMapLeave);
    addEventListener("keydown", onShiftKey, true);
    addEventListener("keyup", onShiftKey, true);
    addEventListener("blur", () => {
      if (!ui.shift) return;
      ui.shift = false;
      if (ui.enabled && ui.mode === "hover") render();
    });

    awbwMountPanel({ key: "to", panel: p, header: p.querySelector(".to-head"), onEnabled: setEnabled });
  }

  function ensureCanvas(res) {
    const map = document.getElementById("gamemap");
    if (!map) return null;
    if (!ui.canvas) {
      ui.canvas = document.createElement("canvas");
      ui.canvas.id = "to-canvas";
    }
    const w = res.mx * TILE;
    const h = res.my * TILE;
    if (ui.canvas.width !== w) ui.canvas.width = w;
    if (ui.canvas.height !== h) ui.canvas.height = h;
    if (ui.canvas.parentNode !== map) map.appendChild(ui.canvas);
    return ui.canvas;
  }

  const SINGLE_FILL = "rgba(230,30,30,0.45)";

  // What is painted: "full" = every (filtered) enemy, "single" = only the hovered enemy unit, null = nothing.
  function view() {
    if (!ui.enabled || !state.res || !state.agg) return null;
    if (ui.mode === "always" || (ui.inMap && ui.shift)) return "full";
    if (ui.over != null && state.byId.has(ui.over)) return "single";
    return null;
  }

  function render() {
    const res = state.res;
    if (!ui.enabled || !res) {
      ui.full = false;
      if (ui.canvas && ui.canvas.parentNode) ui.canvas.parentNode.removeChild(ui.canvas);
      hideTip();
      return;
    }
    const canvas = ensureCanvas(res);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const v = view();
    ui.full = v === "full";
    if (v !== "full") hideTip();
    if (v === "single") {
      // The class filter is deliberately not applied here: hovering a unit shows that unit's own reach.
      const tiles = state.byId.get(ui.over).tiles;
      ctx.fillStyle = SINGLE_FILL;
      for (let i = 0; i < tiles.length; i++) {
        const idx = tiles[i];
        ctx.fillRect((idx % res.mx) * TILE, Math.floor(idx / res.mx) * TILE, TILE, TILE);
      }
      return;
    }
    if (!v) return;
    const { counts } = state.agg;
    ctx.font = "bold 8px Verdana, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,.85)";
    ctx.fillStyle = "#fff";
    for (let idx = 0; idx < counts.length; idx++) {
      const c = counts[idx];
      if (!c) continue;
      const x = (idx % res.mx) * TILE;
      const y = Math.floor(idx / res.mx) * TILE;
      ctx.fillStyle = `rgba(230,30,30,${alphaFor(c)})`;
      ctx.fillRect(x, y, TILE, TILE);
      if (ui.counts && c > 1) {
        ctx.fillStyle = "#fff";
        ctx.strokeText(String(c), x + TILE - 1, y + TILE - 2);
        ctx.fillText(String(c), x + TILE - 1, y + TILE - 2);
      }
    }
    lastHoverIdx = -2; // force tooltip refresh against new data
  }

  function renderSummary() {
    const p = ui.panel;
    const sum = p.querySelector(".to-sum");
    const status = p.querySelector(".to-status");
    const res = state.res;
    if (!ui.enabled) {
      status.textContent = "off";
      sum.textContent = "Overlay is off.";
      return;
    }
    if (state.waiting || !res) {
      status.textContent = "waiting…";
      sum.textContent = "Waiting for the game page to finish loading…";
      return;
    }
    const a = state.agg;
    status.textContent = `${a.tiles} tile${a.tiles === 1 ? "" : "s"}`;
    const g = page();
    let mine = 0;
    let mineHit = 0;
    if (g) {
      for (const id in g.units) {
        const u = g.units[id];
        const o = u && g.players[u.units_players_id];
        if (!o || String(o.players_team) !== res.perspTeam || u.units_carried === "Y") continue;
        mine++;
        const x = +u.units_x;
        const y = +u.units_y;
        if (x >= 0 && y >= 0 && x < res.mx && y < res.my && a.counts[y * res.mx + x]) mineHit++;
      }
    }
    const parts = [
      `<b>${a.tiles}</b> tiles threatened by <b>${a.units}</b> of ${res.enemyUnits} visible enemy units` +
        (res.unarmed ? ` <small>(${res.unarmed} unarmed / out of ammo)</small>` : ""),
      mine ? `<b>${mineHit}</b> of the ${mine} visible units on this team stand on threatened tiles` : "",
      a.max ? `Most overlap: ${a.max} unit${a.max === 1 ? "" : "s"}` : "",
      res.errors ? `<span style="color:#b00">${res.errors} unit(s) could not be computed (see console)</span>` : "",
    ];
    sum.innerHTML = parts.filter(Boolean).join("<br>");
  }

  function fillPlayers() {
    const g = page();
    if (!g || !g.players) return false;
    const sel = ui.panel.querySelector(".to-persp");
    const pids = Object.keys(g.players);
    const sig = pids.join(",") + "|" + g.viewer;
    if (sel.dataset.sig === sig) return true;
    sel.dataset.sig = sig;
    sel.innerHTML = pids
      .map((pid) => {
        const p = g.players[pid];
        const you = +pid === +g.viewer ? " (you)" : "";
        const dead = p.players_eliminated === "Y" ? " ✗" : "";
        return `<option value="${esc(pid)}">${esc(p.users_username || pid)} — ${esc(p.co_name || "?")}${you}${dead}</option>`;
      })
      .join("");
    // Default perspective: the viewing player; spectators get the first live player. A saved choice wins.
    let want = +store.get("persp:" + GAME_ID, 0);
    if (!want || !g.players[want]) want = g.viewer && g.players[g.viewer] ? +g.viewer : 0;
    if (!want) {
      const live = pids.find((pid) => g.players[pid].players_eliminated !== "Y");
      want = +(live || pids[0]);
    }
    ui.persp = want;
    sel.value = String(want);
    return true;
  }

  // ---- recompute ---------------------------------------------------------------

  let timer = 0;
  let settleTimer = 0;
  let retryTimer = 0;

  // Master switch from the panel frame (⏻). Off = inert: no timers, no computation, nothing painted.
  function setEnabled(on) {
    ui.enabled = on;
    clearTimeout(timer);
    clearTimeout(settleTimer);
    clearTimeout(retryTimer);
    timer = settleTimer = retryTimer = 0;
    if (!on) {
      state.res = null;
      state.agg = null;
      state.byId = new Map();
      state.waiting = false;
      ui.over = null;
      render();
      hideTip();
      return;
    }
    recompute(true);
  }

  function applyFilter() {
    if (!state.res) return;
    state.agg = aggregate(state.res, FILTERS[ui.filter] || 0);
    render();
    renderSummary();
  }

  function recompute(force) {
    clearTimeout(timer);
    timer = 0;
    if (!ui.enabled) return;
    if (!fillPlayers()) return scheduleRetry();
    let res = null;
    const t0 = performance.now();
    try {
      res = computeThreats(ui.persp);
    } catch (err) {
      console.error(LOG, err);
    }
    if (!res) {
      state.waiting = true;
      renderSummary();
      return scheduleRetry();
    }
    state.waiting = false;
    state.res = res;
    state.byId = new Map(res.threats.map((t) => [t.id, t]));
    state.fingerprint = fingerprint();
    state.agg = aggregate(res, FILTERS[ui.filter] || 0);
    render();
    renderSummary();
    ui.lastMs = performance.now() - t0;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => recompute(true), 1000);
  }

  // Debounced recompute after live actions. A second, later pass catches state the page updates after
  // animations (units that die or leave vision are removed from unitsInfo with a delay).
  function schedule() {
    if (!ui.enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => recompute(), 150);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => recompute(), 2200);
  }

  // Cheap digest of everything that affects the result; polled so changes the action hooks cannot see
  // (in-page replay viewer, delayed removals, power effects) still refresh the overlay.
  function fingerprint() {
    const g = page();
    if (!g) return "";
    let s = ui.persp + "|" + g.weather.code + "|" + g.turn;
    for (const id in g.units) {
      const u = g.units[id];
      s += ";" + id + "," + u.units_x + "," + u.units_y + "," + u.units_carried + "," + u.units_ammo + "," + u.units_fuel + "," + u.units_movement_points + "," + u.units_long_range;
    }
    return s;
  }

  function poll() {
    if (!ui.enabled || document.hidden || state.waiting) return;
    const fp = fingerprint();
    if (fp && fp !== state.fingerprint) recompute();
  }

  // ---- hooks ---------------------------------------------------------------------

  // Wraps every action handler so that each live (or replayed) action schedules a recompute. Original always runs first and
  // its result is returned untouched; other scripts wrapping the same handlers chain naturally.
  function installHooks() {
    const handlers = window.actionHandlers;
    if (!handlers) return false;
    for (const name of Object.keys(handlers)) {
      const orig = handlers[name];
      if (typeof orig !== "function" || orig.__toWrapped) continue;
      const wrapped = function () {
        try {
          return orig.apply(this, arguments);
        } finally {
          try {
            schedule();
          } catch (err) {
            console.error(LOG, err);
          }
        }
      };
      wrapped.__toWrapped = true;
      handlers[name] = wrapped;
    }
    return true;
  }

  // ---- tooltip ---------------------------------------------------------------------

  let lastHoverIdx = -1;

  function hideTip() {
    if (ui.tip) ui.tip.style.display = "none";
    if (ui.hover) ui.hover.style.display = "none";
    lastHoverIdx = -1;
  }

  function tipHtml(idx) {
    const res = state.res;
    const list = state.agg.lists[idx];
    const groups = new Map();
    for (const ti of list) {
      const t = res.threats[ti];
      const key = t.name + "|" + t.pid + "|" + t.kind;
      let gr = groups.get(key);
      if (!gr) groups.set(key, (gr = { t, hps: [], at: [] }));
      gr.hps.push(t.hp == null ? "?" : t.hp);
      gr.at.push(`${t.x},${t.y}`);
    }
    const how = (t) =>
      t.kind === "indirect" ? `fires at range ${t.rmin}-${t.rmax}, cannot move+fire` : t.kind === "bomb" ? `moves ${t.mp} then explodes (radius ${t.rmax})` : `moves ${t.mp}, ${t.landings} landing tiles`;
    const rows = [...groups.values()]
      .sort((a, b) => b.hps.length - a.hps.length || a.t.name.localeCompare(b.t.name))
      .slice(0, 14)
      .map(
        (gr) =>
          `${gr.hps.length > 1 ? gr.hps.length + "× " : ""}<b>${esc(gr.t.name)}</b> ${esc(gr.hps.join("/"))}HP — ${esc(gr.t.owner)}<br><small>${esc(how(gr.t))} · at ${esc(
            gr.at.slice(0, 4).join(" ")
          )}${gr.at.length > 4 ? " …" : ""}</small>`
      );
    const extra = groups.size > 14 ? `<br><small>+${groups.size - 14} more groups</small>` : "";
    const f = ui.filter ? ` (that can hit ${ui.filter})` : "";
    return `Threatened by ${list.length} enemy unit${list.length === 1 ? "" : "s"}${f}<br>${rows.join("<br>")}${extra}`;
  }

  function showTileTip(e) {
    const res = state.res;
    if (!res || !state.agg || !ui.canvas || !ui.canvas.isConnected) return;
    const rect = ui.canvas.getBoundingClientRect(); // accounts for the map's zoom transform
    const tx = Math.floor(((e.clientX - rect.left) / rect.width) * res.mx);
    const ty = Math.floor(((e.clientY - rect.top) / rect.height) * res.my);
    if (tx < 0 || ty < 0 || tx >= res.mx || ty >= res.my || !state.agg.counts[ty * res.mx + tx]) {
      hideTip();
      return;
    }
    const idx = ty * res.mx + tx;
    if (idx !== lastHoverIdx) {
      lastHoverIdx = idx;
      ui.tip.innerHTML = tipHtml(idx);
      ui.hover.style.left = tx * TILE + "px";
      ui.hover.style.top = ty * TILE + "px";
      ui.hover.style.display = "block";
      ui.tip.style.display = "block";
    }
    // Keep the tooltip inside the viewport.
    const tw = ui.tip.offsetWidth;
    const th = ui.tip.offsetHeight;
    let left = e.clientX + 14;
    let top = e.clientY + 14;
    if (left + tw > window.innerWidth - 4) left = e.clientX - tw - 14;
    if (top + th > window.innerHeight - 4) top = e.clientY - th - 14;
    ui.tip.style.left = Math.max(4, left) + "px";
    ui.tip.style.top = Math.max(4, top) + "px";
  }

  // Hover mode: the unit under the mouse decides what is painted; Shift shows every enemy. The overlay never
  // takes pointer events, so all of this is driven by listeners on the map and the window.
  function onMapMove(e) {
    if (!ui.enabled) return;
    const span = e.target && e.target.closest ? e.target.closest("span[data-unit-id]") : null;
    const id = span ? +span.getAttribute("data-unit-id") : null;
    if (!ui.inMap || id !== ui.over || e.shiftKey !== ui.shift) {
      ui.inMap = true;
      ui.over = id;
      ui.shift = e.shiftKey;
      if (ui.mode === "hover") render();
    }
    if (ui.full) showTileTip(e);
    else hideTip();
  }

  function onMapLeave() {
    ui.inMap = false;
    ui.over = null;
    if (ui.enabled && ui.mode === "hover") render();
    hideTip();
  }

  function onShiftKey(e) {
    if (e.key !== "Shift" || !ui.enabled) return;
    const down = e.type === "keydown";
    if (ui.shift === down) return;
    ui.shift = down;
    if (ui.inMap && ui.mode === "hover") render();
  }

  // ---- boot --------------------------------------------------------------------------

  // Test/debug handle (read-only helpers): window.__awbwThreat.compute(pid) returns the raw computation.
  window.__awbwThreat = { compute: computeThreats, aggregate, state, ui, recompute };

  buildUI(); // mounting the panel calls setEnabled with the remembered on/off state
  (async () => {
    // The page may still be initialising (globals in TDZ, actionHandlers, damage tables fetched async).
    for (let i = 0; i < 100 && !installHooks(); i++) await new Promise((r) => setTimeout(r, 200));
    if (!window.actionHandlers) console.warn(LOG, "actionHandlers not found; relying on polling only");
  })();
  setInterval(poll, 1500);
})();
