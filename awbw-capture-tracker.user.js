// ==UserScript==
// @name         AWBW Capture Tracker
// @namespace    awbw-capture-tracker
// @version      1.2.0
// @description  Shows property captures in progress (points left, ETA), capture-limit progress and income now vs. projected on Advance Wars By Web.
// @homepageURL  https://github.com/ctrlc03/awbw-assist
// @supportURL   https://github.com/ctrlc03/awbw-assist/issues
// @updateURL    https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-capture-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-capture-tracker.user.js
// @match        https://awbw.amarriner.com/game.php*
// @match        https://awbw.amarriner.com/moveplanner.php*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Rules (sources)
  // ---------------------------------------------------------------------------
  // * A property starts with buildings_capture = 20 (game.js: resetBuildingCapture / deleteUnitInfo set it
  //   back to 20). The Capt payload carries the new remaining points; <20 means "in progress",
  //   a completed capture arrives as the building with its new owner and buildings_capture = 20
  //   (game.js captureHandler).
  // * A capture action removes the capturer's displayed HP (1..10) from the points. Sami's footsoldiers
  //   remove floor(1.5 * HP) (AWBW CO chart: "50% capture point bonus (rounded down)"); with Victory March
  //   (SCOP) they capture instantly. No other CO changes capture speed.
  // * The page resets a capture when the capturer leaves the tile (Move → resetBuildingCapture) or dies
  //   (Fire/Delete/Explode → deleteUnitInfo / resetBuildingCapture); the tracker reads buildingsInfo after
  //   every handler, so the reset is picked up with no extra data.
  // * Income: funds-per-property (game setting "Funds", shown in #showinfo) for every City, Base, Airport,
  //   Port and HQ. Com Towers and Labs give none (verified against players_income; AWBW CO chart for Sasha:
  //   "labs, comtowers ... do not get additional income"). Sasha gets +100 per income property.

  const PLANNER = location.pathname.endsWith("/moveplanner.php");
  if (!document.getElementById("gamemap")) return;
  const GAME_ID = +new URLSearchParams(location.search).get("games_id");
  if (!GAME_ID) return; // also covers moveplanner.php?maps_id=
  if (PLANNER && (typeof unitsInfo === "undefined" || !unitsInfo)) return; // eslint-disable-line no-undef

  const LOG = "[AWBW capture tracker]";
  const TILE = 16;
  const POLL_MS = 1000;
  const PLANNER_POLL_MS = 500;
  const FULL = 20;
  const STORE = "awbw-ct:";
  const INCOME_TYPES = new Set(["City", "Base", "Airport", "Port", "HQ"]);
  const FOOT = new Set(["Infantry", "Mech"]);

  // Page globals declared with let/const are reachable by bare name only (no window property).
  const G = {
    buildingsInfo: () => (typeof buildingsInfo !== "undefined" ? buildingsInfo : null), // eslint-disable-line no-undef
    unitMap: () => (typeof unitMap !== "undefined" ? unitMap : null), // eslint-disable-line no-undef
    unitsInfo: () => (typeof unitsInfo !== "undefined" ? unitsInfo : null), // eslint-disable-line no-undef
    playersInfo: () => (typeof playersInfo !== "undefined" ? playersInfo : null), // eslint-disable-line no-undef
    viewerPId: () => (typeof viewerPId !== "undefined" ? viewerPId : 0), // eslint-disable-line no-undef
    currentTurn: () => (typeof currentTurn !== "undefined" ? currentTurn : null), // eslint-disable-line no-undef
    gameDay: () => (typeof gameDay !== "undefined" ? gameDay : null), // eslint-disable-line no-undef
    captureLimit: () => (typeof gameCaptureLimit !== "undefined" ? gameCaptureLimit : null), // eslint-disable-line no-undef
  };

  const num = (v) => (v === "" || v == null || v === "?" || isNaN(+v) ? null : +v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (v) => (v == null ? "?" : Math.round(v).toLocaleString("en-US"));
  const fmtDelta = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(Math.round(v)).toLocaleString("en-US");

  // ---------------------------------------------------------------------------
  // Model: page state → { caps, players, settings }
  // ---------------------------------------------------------------------------

  function propertyType(terrainName) {
    const m = /(HQ|Airport|Port|Base|City|Lab|Com Tower)$/i.exec(terrainName || "");
    if (!m) return null;
    const t = m[1].toLowerCase();
    return t === "hq" ? "HQ" : t === "com tower" ? "Com Tower" : t[0].toUpperCase() + t.slice(1);
  }

  // Game settings table (#showinfo) is the only place the funds-per-property / capture-limit values are exposed.
  // The planner page has no such table: it fetches the game page once (same origin) and caches the two values.
  let settingsCache = null;
  function parseSettings(rows) {
    const out = { funds: null, captureLimit: null };
    let found = false;
    for (const [label, val] of rows) {
      if (label === "Funds:") {
        out.funds = num(val.replace(/[^\d]/g, "") || null);
        found = true;
      } else if (label === "Capture Limit:") {
        out.captureLimit = /^\d+$/.test(val) && +val > 0 ? +val : null;
        found = true;
      }
    }
    return found ? out : null;
  }
  function readSettings() {
    if (settingsCache) return settingsCache;
    if (PLANNER) return { funds: null, captureLimit: null };
    const rows = [];
    for (const td of document.querySelectorAll("#showinfo td")) rows.push([td.textContent.trim(), td.nextElementSibling ? td.nextElementSibling.textContent.trim() : ""]);
    const out = parseSettings(rows);
    if (out) {
      settingsCache = out;
      return out;
    }
    // Table not on the page: fall back to the inline constant (the page uses 1000 for "Off").
    const c = num(G.captureLimit());
    return { funds: null, captureLimit: c != null && c > 0 && c < 1000 ? c : null };
  }

  let remoteRequested = false;
  async function loadRemoteSettings() {
    if (remoteRequested || settingsCache) return;
    remoteRequested = true;
    const key = STORE + "settings:" + GAME_ID;
    try {
      const cached = JSON.parse(localStorage.getItem(key) || "null");
      if (cached && "funds" in cached) {
        settingsCache = cached;
        update();
        return;
      }
    } catch (_) {}
    try {
      const res = await fetch("game.php?games_id=" + GAME_ID, { credentials: "same-origin" });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const rows = [];
      for (const td of doc.querySelectorAll("#showinfo td")) rows.push([td.textContent.trim(), td.nextElementSibling ? td.nextElementSibling.textContent.trim() : ""]);
      const out = parseSettings(rows);
      if (!out) return;
      settingsCache = out;
      if (ui.enabled) {
        try {
          localStorage.setItem(key, JSON.stringify(out));
        } catch (_) {}
        update();
      }
    } catch (err) {
      console.warn(LOG, "could not read game settings for the planner", err);
    }
  }

  function captureRate(unit, player) {
    const hp = unit ? num(unit.units_hit_points) : null;
    if (hp == null) return null;
    if (player && player.co === "Sami" && FOOT.has(unit.units_name)) {
      if (player.power === "S") return Infinity; // Victory March: instant capture
      return Math.floor(hp * 1.5);
    }
    return hp;
  }

  function displayedIncome(pid) {
    const el = PLANNER ? null : document.querySelector("#player" + pid + " .player-income");
    const t = el ? el.textContent.trim() : "";
    if (/^\d+$/.test(t)) return +t;
    const info = G.playersInfo() && G.playersInfo()[pid];
    return info && num(info.players_income) != null ? +info.players_income : null;
  }

  // Planner: units created in the planner may lack units_players_id; fall back to the country code.
  function unitPid(unit, players) {
    if (unit.units_players_id != null && players[unit.units_players_id]) return String(unit.units_players_id);
    const pi = G.playersInfo() || {};
    for (const pid in pi) if (pi[pid].countries_code === unit.countries_code) return String(pid);
    return unit.units_players_id != null ? String(unit.units_players_id) : null;
  }

  // Planner: "Change building" only rewrites terrain_name/terrain_country_code (buildings_players_id stays), so the
  // country code wins when present ("neutral" = unowned).
  function ownerOf(b, players) {
    if (PLANNER && typeof b.terrain_country_code === "string") {
      if (b.terrain_country_code === "" || b.terrain_country_code === "neutral") return "";
      const pi = G.playersInfo() || {};
      for (const pid in pi) if (pi[pid].countries_code === b.terrain_country_code) return String(pid);
      return "";
    }
    return b.buildings_players_id == null ? "" : String(b.buildings_players_id);
  }

  function buildModel() {
    const bi = G.buildingsInfo();
    const pi = G.playersInfo();
    if (!bi || !pi) return null;
    const um = PLANNER ? {} : G.unitMap() || {};
    const ui = G.unitsInfo() || {};
    const turn = G.currentTurn();
    const settings = readSettings();

    const players = {};
    const order = [];
    for (const pid in pi) {
      const p = pi[pid];
      players[pid] = {
        pid,
        name: p.users_username || p.countries_name || "#" + pid,
        team: p.players_team != null ? String(p.players_team) : pid,
        co: p.co_name || "",
        power: p.players_co_power_on || "N",
        eliminated: p.players_eliminated === "Y",
        order: num(p.players_order) != null ? +p.players_order : order.length,
        owned: 0,
        incomeProps: 0,
        gain: 0, // income properties it would gain
        loss: 0, // income properties it would lose
        gainAll: 0, // any property it would gain
        lossAll: 0,
        capturing: 0,
        counts: {},
      };
      order.push(pid);
    }
    const teamOf = (pid) => (pid !== "" && players[pid] ? players[pid].team : null);

    const plannerUnits = new Map();
    if (PLANNER) {
      for (const k in ui) {
        const u = ui[k];
        if (!u || u.units_carried === "Y") continue;
        const key = u.units_x + "," + u.units_y;
        const prev = plannerUnits.get(key);
        if (!prev || (FOOT.has(u.units_name) && !FOOT.has(prev.units_name)) || (u.units_capture === 1 && prev.units_capture !== 1 && FOOT.has(u.units_name))) plannerUnits.set(key, u);
      }
    }
    const caps = [];
    for (const xs in bi) {
      const col = bi[xs];
      for (const ys in col) {
        const b = col[ys];
        if (!b) continue;
        const type = propertyType(b.terrain_name);
        if (!type) continue;
        const owner = ownerOf(b, players);
        if (owner !== "" && players[owner]) {
          const P = players[owner];
          P.owned++;
          P.counts[type] = (P.counts[type] || 0) + 1;
          if (INCOME_TYPES.has(type)) P.incomeProps++;
        }
        const left = num(b.buildings_capture);
        if (left == null || left >= FULL) continue;
        const x = +xs;
        const y = +ys;
        const unit = PLANNER ? plannerUnits.get(x + "," + y) || null : um[x] && um[x][y] ? ui[um[x][y].units_id] : null;
        const capPid = unit ? unitPid(unit, players) : null;
        const capP = capPid != null ? players[capPid] : null;
        // Planner quirk: capturing a property of the capturer's own team still decrements buildings_capture; not a real capture.
        if (PLANNER && capP && owner !== "" && players[owner] && players[owner].team === capP.team) continue;
        const hp = unit ? num(unit.units_hit_points) : null;
        const rate = captureRate(unit, capP);
        const turns = rate == null ? null : rate === Infinity ? (left <= 0 ? 0 : 1) : left <= 0 ? 0 : rate <= 0 ? null : Math.ceil(left / rate);
        const now = !!capP && String(turn) === capPid && unit && unit.units_moved !== 1 && unit.units_moved !== "1";
        caps.push({
          key: x + "," + y,
          x,
          y,
          buildingId: b.buildings_id,
          type,
          income: INCOME_TYPES.has(type),
          left: Math.max(0, left), // planner can go below 0 (planned capture already complete)
          owner,
          capPid,
          unitId: unit ? +unit.units_id : null,
          unitName: unit ? unit.units_name : null,
          hp,
          rate,
          turns,
          now,
          foot: !!unit && FOOT.has(unit.units_name),
        });
      }
    }

    for (const c of caps) {
      const O = c.owner !== "" ? players[c.owner] : null;
      const C = c.capPid != null ? players[c.capPid] : null;
      if (O) {
        O.lossAll++;
        if (c.income) O.loss++;
        O.capturing++;
      }
      if (C) {
        C.gainAll++;
        if (c.income) C.gain++;
        C.capturing++;
      }
    }

    // Income: displayed value is authoritative; rate per property comes from the game setting (+100 for Sasha),
    // falling back to displayed income / income properties when the setting cannot be read.
    // Rate shared by most players (used when a player has no income property to infer from, e.g. in the planner where the
    // game settings are not on the page and no setting was fetched yet).
    const votes = {};
    for (const pid of order) {
      const P = players[pid];
      const d = displayedIncome(pid);
      if (d != null && P.incomeProps > 0 && d % P.incomeProps === 0) {
        const r = d / P.incomeProps - (P.co === "Sasha" ? 100 : 0);
        votes[r] = (votes[r] || 0) + 1;
      }
    }
    const best = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
    const modeRate = best != null ? +best : null;
    for (const pid of order) {
      const P = players[pid];
      P.displayed = displayedIncome(pid);
      let rate = settings.funds != null ? settings.funds + (P.co === "Sasha" && settings.funds > 0 ? 100 : 0) : null;
      let source = rate != null ? "game setting" : null;
      if (P.displayed != null && P.incomeProps > 0 && P.displayed % P.incomeProps === 0) {
        const inferred = P.displayed / P.incomeProps;
        if (rate == null || inferred !== rate) {
          source = rate == null ? "displayed income / properties" : "displayed income / properties (differs from setting)";
          rate = inferred;
        }
      }
      if (rate == null) {
        rate = modeRate != null ? modeRate : 1000;
        source = modeRate != null ? "most common rate among players" : "assumed 1000";
      }
      P.rate = rate;
      P.rateSource = source;
      P.computed = P.incomeProps * rate;
      P.income = P.displayed != null ? P.displayed : P.computed;
      P.mismatch = P.displayed != null && P.displayed !== P.computed;
      P.projected = P.income + rate * (P.gain - P.loss);
      P.ownedAfter = P.owned + P.gainAll - P.lossAll;
    }

    caps.sort((a, b) => (a.turns == null ? 99 : a.turns) - (b.turns == null ? 99 : b.turns) || a.left - b.left || a.x - b.x || a.y - b.y);
    const list = order.map((pid) => players[pid]).sort((a, b) => a.order - b.order);
    return { caps, players, list, settings, day: G.gameDay(), turn: turn != null ? String(turn) : null };
  }

  const pname = (m, pid) => (pid === "" || pid == null ? "Neutral" : m.players[pid] ? m.players[pid].name : "#" + pid);

  function etaLabel(c) {
    if (c.turns == null) return "?";
    if (c.turns === 0) return "planned ✓";
    if (c.turns === 1) return PLANNER ? "1 more" : c.now ? "this turn" : "next turn";
    return c.turns + (PLANNER ? " more" : " turns");
  }

  function etaTitle(c) {
    if (c.turns == null) return "Capturer HP is hidden or unknown";
    if (c.turns === 0) return "Planned capture is complete: the planner does not change the owner, but the projected income counts it";
    const how = c.rate === Infinity ? "instant (Sami SCOP active)" : `${c.rate} pt/turn (capturer HP ${c.hp}${c.rate !== c.hp ? ", Sami +50%" : ""})`;
    if (PLANNER) return `${c.left} pts left at ${how} → ${c.turns} more capture action${c.turns === 1 ? "" : "s"}`;
    return `${c.left} pts left at ${how} → ${c.turns} capture action${c.turns === 1 ? "" : "s"}; ` + (c.now ? "first one can be done this turn" : "first one at the capturer's next turn");
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const css = `
  #ct-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:150;pointer-events:none}
  #ct-layer .ct-mark{position:absolute;width:${TILE}px;height:${TILE}px;box-sizing:border-box;border:1px solid var(--ct-c,#e08a00);
    box-shadow:0 0 0 1px rgba(255,255,255,.55) inset;pointer-events:none}
  #ct-layer .ct-mark.ct-hl{outline:2px solid #ffd400;outline-offset:1px;z-index:2}
  #ct-layer .ct-pill{position:absolute;left:50%;top:${TILE - 1}px;transform:translateX(-50%);display:flex;white-space:nowrap;
    font:bold 7px/8px Verdana,sans-serif;color:#fff;border-radius:2px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.55);pointer-events:none}
  #ct-layer .ct-pill i{font-style:normal;padding:0 1.5px}
  #ct-layer .ct-pts{background:var(--ct-c,#e08a00)}
  #ct-layer .ct-eta{background:#1f2a44}
  #ct-layer .ct-hq .ct-pts{background:#b00020}
  #ct-panel{display:flex;flex-direction:column;min-height:0;background:#fff;color:#222;border:1px solid #888;border-radius:6px;
    box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px Verdana,sans-serif}
  #ct-panel.ct-min .ct-body{display:none}
  #ct-panel .ct-head{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#2c3e66;color:#fff;border-radius:5px 5px 0 0;cursor:pointer;user-select:none}
  #ct-panel.ct-min .ct-head{border-radius:5px}
  #ct-panel .ct-title{font-weight:bold;flex:1}
  #ct-panel .ct-status{font-size:10px;opacity:.85}
  #ct-panel .ct-body{display:flex;flex-direction:column;min-height:0}
  #ct-panel .ct-controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid #ddd}
  #ct-panel .ct-controls select{font-size:11px;max-width:150px}
  #ct-panel .ct-scroll{overflow:auto;min-height:0;max-height:42vh}
  #ct-panel table{border-collapse:collapse;width:100%}
  #ct-panel th{position:sticky;top:0;background:#eef1f7;font-size:10px;text-align:right;padding:3px 4px;white-space:nowrap}
  #ct-panel td{padding:2px 4px;text-align:right;border-top:1px solid #f0f0f0;font-size:11px}
  #ct-panel th:first-child,#ct-panel td:first-child{text-align:left}
  #ct-panel .ct-caps td:nth-child(2){text-align:left}
  #ct-panel .ct-caps th:nth-child(2){text-align:left}
  #ct-panel tbody tr:hover td{background:#fff6c8}
  #ct-panel .ct-sub{background:#f6f6f6;font-weight:bold;font-size:10px;padding:2px 8px;border-top:1px solid #ddd;border-bottom:1px solid #ddd}
  #ct-panel .ct-n{display:inline-block;max-width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
  #ct-panel .ct-up{color:#1d7a34}
  #ct-panel .ct-down{color:#b3261e}
  #ct-panel .ct-dim{color:#888}
  #ct-panel .ct-hq td{background:#ffe9ea}
  #ct-panel tr.ct-sel td{background:#e4edff}
  #ct-panel .ct-log{padding:3px 8px;font-size:10px;color:#555;border-top:1px solid #ddd;max-height:64px;overflow:auto}
  #ct-panel .ct-empty{text-align:center!important;color:#888;padding:6px}
  `;

  const ui = {
    panel: null,
    status: null,
    capsBody: null,
    playersBody: null,
    filterSel: null,
    log: null,
    layer: null,
    minimized: localStorage.getItem(STORE + "min") === "1",
    badges: localStorage.getItem(STORE + "badges") !== "0",
    model: null,
    sig: "",
    hover: null,
    events: [],
    prev: null,
    enabled: true,
  };

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

  // Switch the plugin on/off: off removes the map layer and makes timers/hooks inert; on re-reads page state.
  function setEnabled(on) {
    ui.enabled = !!on;
    if (!ui.enabled) {
      setHover(null);
      if (ui.layer) ui.layer.remove();
      ui.layer = null;
      ui.sig = "";
      ui.prev = null;
      return;
    }
    ui.sig = "";
    if (PLANNER) loadRemoteSettings();
    update();
  }

  function buildUI() {
    const style = document.createElement("style");
    style.id = "ct-style";
    style.textContent = css;
    document.head.appendChild(style);

    const p = document.createElement("div");
    p.id = "ct-panel";
    if (ui.minimized) p.classList.add("ct-min");
    p.innerHTML = `
      <div class="ct-head"><span class="ct-title">${PLANNER ? "Captures (planner)" : "Captures"}</span><span class="ct-status"></span><span class="ct-toggle"></span></div>
      <div class="ct-body">
        <div class="ct-controls">
          <select class="ct-filter" title="Show only captures involving this player"><option value="">All players</option></select>
          <label><input type="checkbox" class="ct-badges"> map badges</label>
        </div>
        <div class="ct-scroll">
          <table class="ct-caps">
            <thead><tr>
              <th>Property</th><th>Owner → Capturer</th>
              <th title="Capture points left (property is captured at 0; full is 20)">Left</th>
              <th title="Capture actions still needed by the current capturer, assuming its HP does not change">ETA</th>
              <th title="Capturer HP (capture points per turn)">HP</th>
            </tr></thead>
            <tbody class="ct-caps-body"></tbody>
          </table>
          <div class="ct-sub">Players: properties · income now → if all captures complete</div>
          <table class="ct-players">
            <thead><tr>
              <th>Player</th>
              <th title="Owned properties (+ in progress / − being lost)">Props</th>
              <th title="Income shown by the page">Income</th>
              <th title="Income if every in-progress capture completes (gains and losses)">Projected</th>
              <th class="ct-limit-h" title="Capture limit progress" style="display:none">Limit</th>
            </tr></thead>
            <tbody class="ct-players-body"></tbody>
          </table>
        </div>
        <div class="ct-log"></div>
      </div>`;
    ui.panel = p;
    ui.status = p.querySelector(".ct-status");
    ui.capsBody = p.querySelector(".ct-caps-body");
    ui.playersBody = p.querySelector(".ct-players-body");
    ui.filterSel = p.querySelector(".ct-filter");
    ui.log = p.querySelector(".ct-log");

    const toggle = p.querySelector(".ct-toggle");
    toggle.textContent = ui.minimized ? "▴" : "▾";
    p.querySelector(".ct-head").addEventListener("click", () => {
      ui.minimized = !ui.minimized;
      p.classList.toggle("ct-min", ui.minimized);
      toggle.textContent = ui.minimized ? "▴" : "▾";
      localStorage.setItem(STORE + "min", ui.minimized ? "1" : "0");
    });
    const badges = p.querySelector(".ct-badges");
    badges.checked = ui.badges;
    badges.addEventListener("change", () => {
      ui.badges = badges.checked;
      localStorage.setItem(STORE + "badges", ui.badges ? "1" : "0");
      renderMarks();
    });
    ui.filterSel.addEventListener("change", () => {
      renderPanel();
    });
    ui.capsBody.addEventListener("mouseover", (e) => {
      const tr = e.target.closest("tr[data-key]");
      setHover(tr ? tr.getAttribute("data-key") : null);
    });
    ui.capsBody.addEventListener("mouseleave", () => setHover(null));
    ui.capsBody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-key]");
      if (!tr) return;
      const c = ui.model && ui.model.caps.find((k) => k.key === tr.getAttribute("data-key"));
      const span = c && (document.querySelector(`#gamemap span[data-building-id='${c.buildingId}']`) || document.getElementById("building_" + c.buildingId));
      if (span && span.scrollIntoView) span.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    });
    awbwMountPanel({ key: "ct", panel: p, header: p.querySelector(".ct-head"), onEnabled: setEnabled });
  }

  function setHover(key) {
    ui.hover = key;
    if (!ui.layer) return;
    for (const el of ui.layer.children) el.classList.toggle("ct-hl", !!key && el.getAttribute("data-key") === key);
  }

  function ensureLayer() {
    const map = document.getElementById("gamemap");
    if (!map) return null;
    if (!ui.layer || ui.layer.parentElement !== map) {
      ui.layer = document.createElement("div");
      ui.layer.id = "ct-layer";
      map.appendChild(ui.layer);
    }
    return ui.layer;
  }

  function markColor(m, c) {
    const vid = G.viewerPId();
    const vp = vid && m.players[vid] ? m.players[vid] : null;
    if (!vp) return "#e08a00";
    const capTeam = c.capPid != null && m.players[c.capPid] ? m.players[c.capPid].team : null;
    const ownTeam = c.owner !== "" && m.players[c.owner] ? m.players[c.owner].team : null;
    if (capTeam === vp.team) return "#2e9e4f"; // we are capturing
    if (ownTeam === vp.team) return "#d6322f"; // we are being captured
    return "#e08a00";
  }

  function renderMarks() {
    const layer = ensureLayer();
    if (!layer) return;
    const m = ui.model;
    const caps = m && ui.badges ? m.caps : [];
    const have = new Map();
    for (const el of [...layer.children]) have.set(el.getAttribute("data-key"), el);
    const seen = new Set();
    for (const c of caps) {
      seen.add(c.key);
      let el = have.get(c.key);
      if (!el) {
        el = document.createElement("div");
        el.className = "ct-mark";
        el.setAttribute("data-key", c.key);
        layer.appendChild(el);
      }
      el.style.left = c.x * TILE + "px";
      el.style.top = c.y * TILE + "px";
      el.style.setProperty("--ct-c", markColor(m, c));
      el.classList.toggle("ct-hq", c.type === "HQ");
      el.classList.toggle("ct-hl", ui.hover === c.key);
      const eta = c.turns == null ? "?" : c.rate === Infinity ? "⚡" : c.turns === 0 ? "✓" : c.turns + "t";
      const html = `<span class="ct-pill"><i class="ct-pts">${c.left}</i><i class="ct-eta">${eta}</i></span>`;
      if (el.innerHTML !== html) el.innerHTML = html;
    }
    for (const [key, el] of have) if (!seen.has(key)) el.remove();
  }

  function renderPanel() {
    const m = ui.model;
    if (!m) return;
    // filter select
    const sel = ui.filterSel;
    const want = m.list.filter((p) => !p.eliminated).map((p) => p.pid);
    const haveOpts = [...sel.options].slice(1).map((o) => o.value);
    if (want.join() !== haveOpts.join()) {
      const cur = sel.value;
      sel.length = 1;
      for (const pid of want) {
        const o = document.createElement("option");
        o.value = pid;
        o.textContent = m.players[pid].name;
        sel.appendChild(o);
      }
      sel.value = want.includes(cur) ? cur : "";
    }
    const filter = sel.value;
    const caps = m.caps.filter((c) => !filter || c.owner === filter || c.capPid === filter);
    ui.status.textContent = m.caps.length ? `${m.caps.length} in progress` : "none in progress";

    ui.capsBody.innerHTML = caps.length
      ? caps
          .map((c) => {
            const stale = c.unitId == null;
            const o = pname(m, c.owner);
            const cp = stale ? "?" : pname(m, c.capPid);
            const hpTxt = c.hp == null ? "?" : c.hp;
            const title =
              (stale ? "No visible unit on this property" : `${c.unitName} #${c.unitId}`) +
              (c.type === "HQ" ? " — capturing an HQ eliminates its owner" : "");
            return `<tr data-key="${c.key}" class="${c.type === "HQ" ? "ct-hq" : ""}" title="${esc(title)}">
              <td>${esc(c.type)} <small>(${c.x},${c.y})</small>${c.income ? "" : ' <small class="ct-dim">no income</small>'}</td>
              <td><span class="ct-n">${esc(o)}</span> → <span class="ct-n">${esc(cp)}</span></td>
              <td>${c.left}</td>
              <td title="${esc(etaTitle(c))}">${esc(etaLabel(c))}</td>
              <td>${hpTxt}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="ct-empty">${filter ? "No captures involving this player" : "No captures in progress"}</td></tr>`;

    const limit = m.settings.captureLimit;
    ui.panel.querySelector(".ct-limit-h").style.display = limit ? "" : "none";
    ui.playersBody.innerHTML = m.list
      .filter((p) => !p.eliminated)
      .map((p) => {
        const d = p.projected - p.income;
        const plusMinus =
          (p.gainAll ? `<small class="ct-up">+${p.gainAll}</small> ` : "") + (p.lossAll ? `<small class="ct-down">−${p.lossAll}</small>` : "");
        const counts = Object.keys(p.counts)
          .sort()
          .map((k) => `${p.counts[k]} ${k}`)
          .join(", ");
        const incTitle = `Page shows ${p.displayed == null ? "no income" : fmt(p.displayed)}; ${p.incomeProps} income properties × ${fmt(p.rate)} (${p.rateSource}) = ${fmt(p.computed)}${
          p.mismatch ? " — differs from the page (fog hides some properties?)" : ""
        }`;
        const projTitle = `${p.gain} income propert${p.gain === 1 ? "y" : "ies"} gained, ${p.loss} lost if all in-progress captures complete`;
        const limitCell = limit
          ? `<td title="Owned properties / capture limit ${limit}. Assumes every owned property counts (the server rule is not exposed to the client).">${p.owned}/${limit}${
              p.ownedAfter !== p.owned ? ` <small class="${p.ownedAfter > p.owned ? "ct-up" : "ct-down"}">→${p.ownedAfter}</small>` : ""
            }</td>`
          : "";
        return `<tr class="${filter === p.pid ? "ct-sel" : ""}">
          <td><span class="ct-n" title="${esc(p.name)} (${esc(p.co)})">${esc(p.name)}</span></td>
          <td title="${esc(counts || "no properties")}; ${p.incomeProps} produce income">${p.owned} ${plusMinus}</td>
          <td title="${esc(incTitle)}">${fmt(p.income)}${p.mismatch ? ' <small class="ct-down">≠</small>' : ""}</td>
          <td title="${esc(projTitle)}">${p.gain || p.loss ? `<b>${fmt(p.projected)}</b> <small class="${d > 0 ? "ct-up" : d < 0 ? "ct-down" : "ct-dim"}">${fmtDelta(d)}</small>` : '<span class="ct-dim">same</span>'}</td>
          ${limitCell}</tr>`;
      })
      .join("");

    const recent = ui.events.slice(-6).reverse();
    ui.log.style.display = recent.length ? "" : "none";
    ui.log.innerHTML = recent.map((e) => `<div>${esc(e)}</div>`).join("");
  }

  // ---------------------------------------------------------------------------
  // Change log (derived from snapshots, so it covers every handler incl. delayed kill resets)
  // ---------------------------------------------------------------------------

  function diffEvents(prev, cur) {
    const out = [];
    const day = cur.day != null ? "D" + cur.day + " " : "";
    const pk = new Map(prev.caps.map((c) => [c.key, c]));
    const ck = new Map(cur.caps.map((c) => [c.key, c]));
    const who = (m, c) => (c.capPid != null ? pname(m, c.capPid) : "?");
    for (const c of cur.caps) {
      const o = pk.get(c.key);
      if (!o) out.push(`${day}${who(cur, c)} ${c.left <= 0 ? "planned a capture of" : "started capturing"} ${c.type} (${c.x},${c.y}): ${c.left} left`);
      else if (o.left !== c.left) out.push(`${day}${who(cur, c)} ${c.left <= 0 ? "completes" : "capturing"} ${c.type} (${c.x},${c.y}): ${c.left} left`);
    }
    for (const o of prev.caps) {
      if (ck.has(o.key)) continue;
      const b = G.buildingsInfo();
      const now = b && b[o.x] && b[o.x][o.y];
      const newOwner = now && now.buildings_players_id != null ? String(now.buildings_players_id) : "";
      if (now && newOwner !== o.owner) out.push(`${day}${pname(cur, newOwner)} captured ${o.type} (${o.x},${o.y})`);
      else out.push(`${day}capture of ${o.type} (${o.x},${o.y}) reset (${o.left} pts were left)`);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Update loop
  // ---------------------------------------------------------------------------

  function signature(m) {
    return JSON.stringify([
      m.caps.map((c) => [c.key, c.left, c.owner, c.capPid, c.unitId, c.hp, c.rate === Infinity ? "i" : c.rate, c.turns, c.now]),
      m.list.map((p) => [p.pid, p.name, p.eliminated, p.owned, p.incomeProps, p.displayed, p.rate, p.gain, p.loss, p.gainAll, p.lossAll, p.power]),
      m.settings.captureLimit,
      m.settings.funds,
      G.viewerPId(),
    ]);
  }

  function update() {
    if (!ui.enabled) return;
    let m;
    try {
      m = buildModel();
    } catch (err) {
      console.error(LOG, err);
      return;
    }
    if (!m) return;
    const layerGone = ui.layer && !ui.layer.isConnected;
    const sig = signature(m);
    if (sig === ui.sig && !layerGone) return;
    if (ui.prev) {
      const ev = diffEvents(ui.prev, m);
      if (ev.length) ui.events.push(...ev);
      if (ui.events.length > 50) ui.events.splice(0, ui.events.length - 50);
    }
    ui.prev = m;
    ui.sig = sig;
    ui.model = m;
    renderPanel();
    renderMarks();
  }

  let frame = 0;
  function schedule() {
    if (!ui.enabled) return;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  }

  // Wraps each action handler currently installed. Other userscripts wrap the same entries; every wrapper
  // chains to whatever function it found. `__ctWrapped` is private to this script.
  function installHooks() {
    const handlers = window.actionHandlers;
    if (!handlers) return false;
    for (const name of Object.keys(handlers)) {
      const orig = handlers[name];
      if (typeof orig !== "function" || orig.__ctWrapped) continue;
      const wrapped = function () {
        const out = orig.apply(this, arguments);
        try {
          schedule();
          // Move animations and kill resets are applied by game.js timers after the handler returns.
          setTimeout(update, 1200);
          setTimeout(update, 3000);
        } catch (err) {
          console.error(LOG, "hook failed", err);
        }
        return out;
      };
      wrapped.__ctWrapped = true;
      handlers[name] = wrapped;
    }
    return true;
  }

  // ---- boot -------------------------------------------------------------------

  buildUI(); // mounting the panel calls setEnabled with the remembered on/off state
  if (PLANNER) {
    // The planner has no actionHandlers: it mutates unitsInfo/buildingsInfo in place, so poll (cheap, signature-compared)
    // and refresh right after any click (planned capture/move/delete) instead of waiting for the next tick.
    setInterval(update, PLANNER_POLL_MS);
    document.addEventListener(
      "click",
      () => {
        schedule();
        setTimeout(update, 120);
      },
      true
    );
  } else {
    update();
    setInterval(update, POLL_MS);
    (async () => {
      for (let i = 0; i < 50 && !installHooks(); i++) await new Promise((r) => setTimeout(r, 200));
      if (!window.actionHandlers) console.warn(LOG, "actionHandlers not found; relying on polling only");
      update();
    })().catch((err) => console.error(LOG, err));
  }
})();
