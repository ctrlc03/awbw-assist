// ==UserScript==
// @name         AWBW Fog Memory
// @namespace    awbw-fog-memory
// @version      1.1.0
// @description  Remembers enemy units you have seen in fog-of-war games and draws faded "ghost" markers (with the day last seen) where they disappeared.
// @homepageURL  https://github.com/ctrlc03/awbw-assist
// @supportURL   https://github.com/ctrlc03/awbw-assist/issues
// @updateURL    https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-fog-memory.user.js
// @downloadURL  https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-fog-memory.user.js
// @match        https://awbw.amarriner.com/game.php*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

(function () {
  "use strict";

  if (!document.getElementById("gamemap")) return;

  const LOG = "[AWBW fog memory]";
  const STORE_PREFIX = "awbw-fm:v1:";
  const STORE_INDEX = "awbw-fm:index";
  const MAX_STORED_GAMES = 40;
  const POLL_MS = 1000;
  const GAME_ID = +new URLSearchParams(location.search).get("games_id");
  if (!GAME_ID) return;

  // ---------------------------------------------------------------------------
  // Page access. Inline game.php globals are let/const (bare names, not window properties);
  // game.js `var` functions are window properties. Everything is read at call time.
  // ---------------------------------------------------------------------------
  /* eslint-disable no-undef */
  const page = {
    unitsInfo: () => (typeof unitsInfo !== "undefined" ? unitsInfo : null),
    playersInfo: () => (typeof playersInfo !== "undefined" ? playersInfo : null),
    viewerPId: () => (typeof viewerPId !== "undefined" ? +viewerPId || 0 : 0),
    allViewerPId: () => (typeof allViewerPId !== "undefined" && allViewerPId ? allViewerPId : []),
    gameFog: () => (typeof gameFog !== "undefined" ? gameFog : "N"),
    gameDay: () => (typeof gameDay !== "undefined" ? +gameDay || 0 : 0),
    gameEndDate: () => (typeof gameEndDate !== "undefined" ? gameEndDate : ""),
    freezeGame: () => (typeof freezeGame !== "undefined" ? !!freezeGame : false),
    fogInfo: () => (typeof fogInfo !== "undefined" ? fogInfo : null),
    viewerColors: () => (typeof viewerColors !== "undefined" ? viewerColors : null),
    tp: () => (typeof TP !== "undefined" ? TP : "terrain/aw1/"),
    spriteVersion: () => (typeof SPRITE_VERSION !== "undefined" ? SPRITE_VERSION : ""),
    moveMs: () => (typeof movementSpeed !== "undefined" && +movementSpeed > 0 ? +movementSpeed : 200),
  };
  /* eslint-enable no-undef */

  const num = (v) => (typeof v === "number" ? v : v === "" || v == null || v === "?" || isNaN(+v) ? null : +v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // viewerPId is fixed for the lifetime of a page; it keys the stored memory.
  const VIEWER = page.viewerPId();
  const STORE_KEY = STORE_PREFIX + GAME_ID + ":" + VIEWER;

  // ---------------------------------------------------------------------------
  // Memory
  //   mem[id] = { name, pid, x, y, hp, day, c (countries_code),
  //               vis   1 while the unit is in unitsInfo (i.e. currently visible to the viewer),
  //               fogged 1 once its last-seen tile has been out of vision since the sighting,
  //               hid   1 if it dived (Sub / Stealth) and vanished from view,
  //               out   1 if it walked out of vision from that tile,
  //               by    id of the transport carrying it (0 = none) }
  // A unit is "visible" exactly when game.js holds it in unitsInfo: updateFog / moveUnit / hideUnit /
  // loadUnit delete enemy units from unitsInfo (deleteUnitInfo) the moment they leave the viewer's vision.
  // ---------------------------------------------------------------------------
  const S = {
    mem: {},
    dead: new Set(), // ids known destroyed this session (game.js still lists them during the death animation)
    holdGone: {}, // id -> until: unit already left vision via Move, unitsInfo entry lingers until the animation ends
    holdVis: {}, // id -> until: unit announced (discovered/unloaded) but game.js has not created it yet
    dirty: false,
    saveTimer: 0,
    status: "",
  };

  function loadMem() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      if (c && c.mem && typeof c.mem === "object") S.mem = c.mem;
    } catch (err) {
      console.warn(LOG, "stored memory unreadable, ignoring", err);
    }
  }

  function saveNow() {
    if (!enabled) {
      clearTimeout(S.saveTimer);
      S.saveTimer = 0;
      return;
    }
    clearTimeout(S.saveTimer);
    S.saveTimer = 0;
    S.dirty = false;
    let index = [];
    try {
      index = JSON.parse(localStorage.getItem(STORE_INDEX) || "[]");
    } catch (_) {}
    index = index.filter((k) => k !== STORE_KEY);
    index.push(STORE_KEY);
    const payload = JSON.stringify({ mem: S.mem, saved: Date.now() });
    for (let attempt = 0; attempt < 5; attempt++) {
      while (index.length > MAX_STORED_GAMES) localStorage.removeItem(index.shift());
      try {
        localStorage.setItem(STORE_KEY, payload);
        localStorage.setItem(STORE_INDEX, JSON.stringify(index));
        return;
      } catch (_) {
        if (index.length <= 1) break;
        localStorage.removeItem(index.shift()); // quota: drop the least recently used game
      }
    }
    console.warn(LOG, "could not persist memory (storage full)");
  }

  function markDirty() {
    S.dirty = true;
    if (!S.saveTimer) S.saveTimer = setTimeout(saveNow, 800);
  }

  function clearGameMemory() {
    S.mem = {};
    S.dead.clear();
    S.holdGone = {};
    S.holdVis = {};
    localStorage.removeItem(STORE_KEY);
    try {
      const index = JSON.parse(localStorage.getItem(STORE_INDEX) || "[]").filter((k) => k !== STORE_KEY);
      localStorage.setItem(STORE_INDEX, JSON.stringify(index));
    } catch (_) {
      localStorage.removeItem(STORE_INDEX);
    }
    S.dirty = false;
  }

  // ---- vision helpers ---------------------------------------------------------

  let enabled = false;

  function mode() {
    if (!enabled) return { ok: false, msg: "Switched off." };
    if (page.gameFog() !== "Y") return { ok: false, msg: "Not a fog game — nothing to remember." };
    if (page.gameEndDate()) return { ok: false, msg: "Game over: vision is shared, every unit is visible." };
    if (!page.viewerPId()) return { ok: false, msg: "Spectating: no fog applies to you, nothing is hidden." };
    if (page.allViewerPId().length > 1) return { ok: false, msg: "Hotseat / multi-vision games are not supported." };
    if (page.freezeGame()) return { ok: false, msg: "Replay viewer open — memory paused." };
    return { ok: true, msg: "" };
  }

  function hasVision(team) {
    if (typeof window.hasTeamVision === "function") {
      try {
        return !!window.hasTeamVision(team);
      } catch (_) {}
    }
    const pi = page.playersInfo();
    const v = pi && pi[page.viewerPId()];
    return !!v && v.players_team === team;
  }

  function isEnemyPid(pid) {
    const pi = page.playersInfo();
    const p = pi && pi[pid];
    return !!p && !hasVision(p.players_team);
  }

  const isEnemyUnit = (u) => !!u && u.units_players_id != null && isEnemyPid(u.units_players_id);

  function tileVisible(x, y) {
    const f = page.fogInfo();
    const col = f && f[x];
    return !!col && col[y] > 0;
  }

  // ---- memory mutations -------------------------------------------------------

  // Records (or refreshes) a sighting from a unit object at (x, y). Returns true when anything changed.
  function sight(id, u, x, y, day) {
    const prev = S.mem[id];
    const hp = num(u.units_hit_points);
    const rec = {
      name: u.units_name || (prev && prev.name) || "Unit",
      pid: +u.units_players_id,
      x,
      y,
      hp: hp != null ? hp : prev ? prev.hp : null,
      day,
      c: u.countries_code || (prev && prev.c) || "",
      vis: 1,
      fogged: 0,
      hid: u.units_sub_dive === "Y" || u.units_sub_dive === "D" ? 1 : 0,
      out: 0,
      by: 0,
    };
    S.mem[id] = rec;
    S.dirty = true;
    return !prev || prev.x !== x || prev.y !== y || prev.hp !== rec.hp || prev.day !== day || !prev.vis || prev.by || prev.out || prev.fogged || prev.hid !== rec.hid;
  }

  // Unit is known gone (destroyed, deleted, joined, exploded, crashed): drop it and anything it carried.
  function forget(id) {
    id = +id;
    if (!id) return;
    S.dead.add(id);
    delete S.holdGone[id];
    delete S.holdVis[id];
    if (S.mem[id]) {
      delete S.mem[id];
      markDirty();
    }
    for (const k in S.mem) {
      if (S.mem[k].by === id) {
        S.dead.add(+k);
        delete S.mem[k];
        markDirty();
      }
    }
  }

  function forgetPlayer(pid) {
    pid = +pid;
    for (const k in S.mem) {
      if (S.mem[k].pid === pid) {
        S.dead.add(+k);
        delete S.mem[k];
        S.dirty = true;
      }
    }
    markDirty();
  }

  // Walks game.js's own unit table: refreshes sightings, detects units that just left vision.
  function reconcile() {
    if (!mode().ok) return;
    const units = page.unitsInfo();
    if (!units) return;
    const day = page.gameDay();
    const now = Date.now();
    const seen = new Set();
    let changed = false;
    const pi = page.playersInfo() || {};

    for (const k in units) {
      const u = units[k];
      const id = +u.units_id;
      if (!isEnemyUnit(u)) continue;
      if (S.dead.has(id) || (S.holdGone[id] || 0) > now) continue;
      if (u.units_carried === "Y") continue; // inside a transport: not on the map
      const x = num(u.units_x);
      const y = num(u.units_y);
      if (x == null || y == null) continue;
      seen.add(id);
      if (sight(id, u, x, y, day)) changed = true;
    }

    for (const k in S.mem) {
      const id = +k;
      const m = S.mem[k];
      const p = pi[m.pid];
      if (S.dead.has(id) || (p && p.players_eliminated === "Y")) {
        delete S.mem[k];
        changed = true;
        continue;
      }
      if (seen.has(id)) continue;
      if (m.vis) {
        if ((S.holdVis[id] || 0) > now) continue; // announced, game.js is about to create it
        // It was visible and is no longer. Unexplained loss of a visible unit (vision lost, dive, fuel crash...)
        // keeps its last seen position; `fogged` makes a visible empty tile read as "moved".
        m.vis = 0;
        m.fogged = 1;
        changed = true;
      }
      if (!m.vis && !m.by && !m.fogged && !tileVisible(m.x, m.y)) {
        m.fogged = 1;
        changed = true;
      }
      if (m.by && !units[m.by] && !S.mem[m.by]) {
        // transport is neither visible nor remembered any more: its cargo is gone with it
        delete S.mem[k];
        changed = true;
      }
    }
    if (changed || S.dirty) markDirty();
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Live hooks
  // ---------------------------------------------------------------------------

  function noteDiscovered(d) {
    if (!d || !d.units) return;
    const day = page.gameDay();
    const hold = Date.now() + 6000;
    for (const u of d.units) {
      const id = +u.units_id;
      if (!id || S.dead.has(id) || u.units_carried !== "N" || !isEnemyUnit(u)) continue;
      const x = num(u.units_x);
      const y = num(u.units_y);
      if (x == null || y == null) continue;
      sight(id, u, x, y, day);
      S.holdVis[id] = hold;
    }
  }

  function noteElimination(e) {
    if (e && e.playerId != null) forgetPlayer(e.playerId);
  }

  const PRE = {
    Move(res) {
      const u = res && res.unit;
      const path = res && res.path;
      if (!u || !path || !path.length || !isEnemyUnit(u)) return;
      const id = +u.units_id;
      if (S.dead.has(id)) return;
      const day = page.gameDay();
      const end = path[path.length - 1];
      let lastVis = -1;
      path.forEach((t, i) => {
        if (t.unit_visible) lastVis = i;
      });
      if (lastVis < 0) return; // never in sight: nothing learned
      if (end.unit_visible) {
        sight(id, u, num(end.x), num(end.y), day);
        delete S.holdGone[id];
        return;
      }
      // Walked out of vision: remember it where it was last seen. The game keeps the (moved) unit in
      // unitsInfo until the animation ends; hold it back so the hidden destination is never recorded.
      const x = num(path[lastVis].x);
      const y = num(path[lastVis].y);
      sight(id, u, x, y, day);
      const m = S.mem[id];
      m.vis = 0;
      m.out = 1;
      m.fogged = tileVisible(x, y) ? 0 : 1;
      S.holdGone[id] = Date.now() + path.length * page.moveMs() + 1500;
      markDirty();
    },

    Fire(res) {
      if (!res) return;
      const day = page.gameDay();
      const units = page.unitsInfo() || {};
      for (const side of [res.attacker, res.defender]) {
        if (!side || side === "?" || side.units_id == null) continue;
        const id = +side.units_id;
        const hp = num(side.units_hit_points);
        if (hp === 0) {
          forget(id);
          continue;
        }
        const known = units[id];
        if (known && isEnemyUnit(known) && hp != null) {
          const x = num(side.units_x != null ? side.units_x : known.units_x);
          const y = num(side.units_y != null ? side.units_y : known.units_y);
          if (x != null && y != null) sight(id, Object.assign({}, known, { units_hit_points: hp }), x, y, day);
        }
      }
      noteElimination(res.eliminated);
    },

    Unload(res) {
      const u = res && res.unloadedUnit;
      if (!u || !isEnemyUnit(u)) return;
      const id = +u.units_id;
      const x = num(u.units_x);
      const y = num(u.units_y);
      if (S.dead.has(id) || x == null || y == null) return;
      sight(id, u, x, y, page.gameDay());
      S.holdVis[id] = Date.now() + 3000;
    },

    Load(res) {
      if (!res) return;
      const lid = +res.loadedId;
      const tid = +res.transportId;
      const u = (page.unitsInfo() || {})[lid];
      if (u && isEnemyUnit(u) && !S.dead.has(lid)) {
        const x = num(u.units_x);
        const y = num(u.units_y);
        if (x != null && y != null && !S.mem[lid]) sight(lid, u, x, y, page.gameDay());
      }
      const m = S.mem[lid];
      if (!m) return;
      m.by = tid;
      m.vis = 0;
      m.hid = 0;
      m.out = 0;
      m.day = page.gameDay();
      S.holdGone[lid] = Date.now() + 3000;
      S.dirty = true;
    },

    Hide(res) {
      if (!res) return;
      const id = +res.unitId;
      const u = (page.unitsInfo() || {})[id];
      if (!u || !isEnemyUnit(u) || res.vision) return; // vision: unit stays visible to the viewer's team
      const x = num(u.units_x);
      const y = num(u.units_y);
      if (x == null || y == null) return;
      sight(id, u, x, y, page.gameDay());
      S.mem[id].hid = 1;
    },

    Unhide(res) {
      const u = res && res.unit;
      if (!u || !isEnemyUnit(u)) return;
      const id = +u.units_id;
      const x = num(u.units_x);
      const y = num(u.units_y);
      if (S.dead.has(id) || x == null || y == null) return;
      sight(id, Object.assign({}, u, { units_sub_dive: "N" }), x, y, page.gameDay());
      S.holdVis[id] = Date.now() + 3000;
    },

    Join(res) {
      if (res && res.joinId != null) forget(res.joinId); // the joining unit is consumed
    },

    Delete(res) {
      if (!res) return;
      if (res.deletedId != null) forget(res.deletedId);
      noteElimination(res.eliminated);
    },

    Explode(res) {
      if (res && res.unitId != null) forget(res.unitId);
    },

    Capt(res) {
      if (res) noteElimination(res.eliminated);
    },

    Elimination(res) {
      noteElimination(res);
    },

    Resign(res) {
      noteElimination(res);
    },

    NextTurn(res) {
      // game.js deletes out-of-fuel air/naval units of the player whose turn begins (endTurnHandler)
      const next = res && res.nextPId != null ? +res.nextPId : null;
      if (next == null) return;
      const units = page.unitsInfo() || {};
      for (const k in units) {
        const u = units[k];
        if (+u.units_players_id !== next || !isEnemyUnit(u)) continue;
        if (u.units_fuel <= 0 && (u.units_movement_type === "A" || u.units_movement_type === "S" || u.units_movement_type === "L")) forget(u.units_id);
      }
    },
  };

  // Actions that may carry `discovered` units; Build/Power/Supply/Repair etc. only need a reconcile afterwards.
  const WRAPPED = ["Move", "Fire", "AttackSeam", "Build", "Load", "Unload", "Join", "Delete", "Explode", "Launch", "Hide", "Unhide", "Capt", "Power", "Repair", "Supply", "NextTurn", "Elimination", "Resign"];

  function afterAction(name, res) {
    if (!mode().ok) return;
    reconcile();
    renderAll();
    const settle = name === "Move" && res && res.path ? res.path.length * page.moveMs() + 300 : 0;
    // game.js removes fogged enemies after animation delays (up to ~1 s after a kill / move); look again.
    for (const ms of [80, 450, 1150, settle]) {
      if (!ms) continue;
      setTimeout(() => {
        if (!enabled) return;
        try {
          reconcile();
          renderAll();
        } catch (err) {
          console.error(LOG, err);
        }
      }, ms);
    }
  }

  function installHooks() {
    const handlers = window.actionHandlers;
    if (!handlers) return false;
    for (const name of WRAPPED) {
      const orig = handlers[name];
      if (typeof orig !== "function" || orig.__fm) continue;
      const wrapper = function (res) {
        const ok = mode().ok;
        if (ok) {
          try {
            const snap = res && typeof res === "object" ? JSON.parse(JSON.stringify(res)) : res;
            if (PRE[name]) PRE[name](snap);
            if (snap && snap.discovered) noteDiscovered(snap.discovered);
          } catch (err) {
            console.error(LOG, "pre-hook failed", name, err);
          }
        }
        try {
          return orig.apply(this, arguments);
        } finally {
          try {
            afterAction(name, res);
          } catch (err) {
            console.error(LOG, "post-hook failed", name, err);
          }
        }
      };
      wrapper.__fm = true;
      handlers[name] = wrapper;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Derived view of remembered units
  // ---------------------------------------------------------------------------
  const STATUS_ORDER = { ghost: 0, out: 1, hidden: 2, moved: 3, carried: 4 };
  const STATUS_TEXT = { ghost: "ghost", out: "left sight", hidden: "hidden", moved: "moved", carried: "carried" };

  // Position of a remembered unit's transport, if known.
  function carrierInfo(m) {
    const t = (page.unitsInfo() || {})[m.by];
    if (t) return { name: t.units_name, x: num(t.units_x), y: num(t.units_y), live: true };
    const r = S.mem[m.by];
    if (r) return { name: r.name, x: r.x, y: r.y, live: false };
    return null;
  }

  function entries() {
    const out = [];
    for (const k in S.mem) {
      const m = S.mem[k];
      if (m.vis) continue; // on the map: game.js draws it
      const e = { id: +k, m, x: m.x, y: m.y, show: true, status: "ghost", carrier: null };
      if (m.by) {
        e.status = "carried";
        e.carrier = carrierInfo(m);
        e.show = false;
        if (e.carrier && e.carrier.x != null) {
          e.x = e.carrier.x;
          e.y = e.carrier.y;
        }
      } else if (m.hid) {
        e.status = "hidden";
      } else if (tileVisible(m.x, m.y)) {
        if (m.fogged) {
          e.status = "moved"; // we can see the tile and it is empty
          e.show = false;
        } else {
          e.status = "out"; // it walked out of vision from here; the tile has been in sight ever since
        }
      }
      out.push(e);
    }
    out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.m.day - a.m.day || a.m.name.localeCompare(b.m.name) || a.id - b.id);
    return out;
  }

  // Switch-off from the panel frame: inert (no hooks work, no polling, no storage writes, no overlays).
  // Switching on re-syncs from the page's current unit table.
  function setEnabled(on) {
    enabled = on;
    if (!on) {
      clearTimeout(S.saveTimer);
      S.saveTimer = 0;
      ui.hl = null;
    }
    if (on) reconcile();
    renderAll();
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
  // UI
  // ---------------------------------------------------------------------------
  const css = `
  /* dock and frame styles are injected by awbwMountPanel */
  #fm-layer{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:107}
  .fm-ghost{position:absolute;width:16px;height:16px;pointer-events:none}
  .fm-ghost img.fm-sprite{display:block;width:16px;height:16px;image-rendering:pixelated;opacity:.5;filter:grayscale(.55) brightness(1.05)}
  .fm-ghost.fm-off{display:none}
  .fm-ghost.fm-s-out img.fm-sprite{opacity:.4}
  .fm-ghost.fm-s-hidden img.fm-sprite{opacity:.6}
  .fm-ghost .fm-lbl{position:absolute;left:-2px;bottom:-3px;font:bold 7px/8px Verdana,sans-serif;color:#fff;background:#5b2c8f;
    padding:0 1px;border-radius:2px;white-space:nowrap;letter-spacing:-.2px}
  .fm-ghost .fm-hp{position:absolute;right:-2px;top:-3px;font:bold 7px/8px Verdana,sans-serif;color:#fff;background:#444;padding:0 1px;border-radius:2px}
  .fm-ghost.fm-hl{display:block;outline:2px solid #ffd400;outline-offset:-1px;z-index:5}
  .fm-ghost.fm-hl img.fm-sprite{opacity:.95}
  .fm-ghost.fm-hl.fm-moved{outline-style:dashed}
  #fm-panel{display:flex;flex-direction:column;min-height:0;background:#fff;color:#222;border:1px solid #888;border-radius:6px;
    box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px Verdana,sans-serif}
  #fm-panel.fm-min .fm-body{display:none}
  #fm-panel .fm-head{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#2c3e66;color:#fff;border-radius:5px 5px 0 0;cursor:pointer;user-select:none}
  #fm-panel.fm-min .fm-head{border-radius:5px}
  #fm-panel .fm-title{font-weight:bold;flex:1}
  #fm-panel .fm-count{font-size:10px;opacity:.85}
  #fm-panel .fm-body{display:flex;flex-direction:column;min-height:0}
  #fm-panel .fm-controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #ddd}
  #fm-panel .fm-controls button{font-size:11px}
  #fm-panel .fm-note{padding:5px 8px;font-size:11px;color:#666;border-bottom:1px solid #eee}
  #fm-panel .fm-scroll{overflow:auto;min-height:0;max-height:38vh}
  #fm-panel table{border-collapse:collapse;width:100%}
  #fm-panel th{position:sticky;top:0;background:#eef1f7;font-size:11px;text-align:left;padding:3px 5px}
  #fm-panel td{padding:2px 5px;border-top:1px solid #f0f0f0;white-space:nowrap;font-size:11px}
  #fm-panel tbody tr:hover td{background:#fff6c8}
  #fm-panel tr.fm-r-moved td,#fm-panel tr.fm-r-carried td{color:#888}
  #fm-panel .fm-st{font-weight:bold}
  #fm-panel .fm-empty{text-align:center;color:#888;padding:8px}
  `;

  const ui = {
    layer: null,
    els: new Map(),
    panel: null,
    tbody: null,
    count: null,
    note: null,
    controls: null,
    hl: null,
    show: localStorage.getItem("awbw-fm:show") !== "0",
    minimized: localStorage.getItem("awbw-fm:min") === "1",
  };

  function ensureLayer() {
    const map = document.getElementById("gamemap");
    if (!map) return null;
    if (!ui.layer) {
      ui.layer = document.createElement("div");
      ui.layer.id = "fm-layer";
    }
    if (ui.layer.parentElement !== map) map.appendChild(ui.layer);
    return ui.layer;
  }

  function spriteSrc(m) {
    const colors = page.viewerColors();
    const cc = ((colors && colors[m.pid]) || m.c || "").toLowerCase();
    const name = String(m.name).toLowerCase().replace(" ", "");
    const v = page.spriteVersion();
    return page.tp() + cc + name + ".gif" + (v ? "?v=" + v : "");
  }

  function renderMap() {
    const layer = ensureLayer();
    if (!layer) return;
    const active = mode().ok;
    layer.style.display = active ? "" : "none";
    const keep = new Set();
    if (active) {
      for (const e of entries()) {
        if (e.x == null || e.y == null) continue;
        keep.add(e.id);
        let el = ui.els.get(e.id);
        if (!el) {
          el = document.createElement("span");
          el.className = "fm-ghost";
          el.innerHTML = '<img class="fm-sprite" draggable="false" alt=""><b class="fm-lbl"></b><b class="fm-hp"></b>';
          el.setAttribute("data-fm-id", e.id);
          ui.els.set(e.id, el);
        }
        if (el.parentElement !== layer) layer.appendChild(el);
        const on = ui.show && e.show;
        el.className = `fm-ghost fm-s-${e.status}${on ? "" : " fm-off"}${ui.hl === e.id ? " fm-hl" : ""}${e.show ? "" : " fm-moved"}`;
        el.style.left = e.x * 16 + "px";
        el.style.top = e.y * 16 + "px";
        const img = el.firstChild;
        const src = spriteSrc(e.m);
        if (img.getAttribute("data-src") !== src) {
          img.setAttribute("data-src", src);
          img.src = src;
        }
        const suffix = e.status === "out" ? "→" : e.status === "hidden" ? "≈" : "";
        const lbl = el.children[1];
        const text = "D" + e.m.day + suffix;
        if (lbl.textContent !== text) lbl.textContent = text;
        const hp = el.children[2];
        const hpText = e.m.hp != null && e.m.hp < 10 ? String(e.m.hp) : "";
        if (hp.textContent !== hpText) hp.textContent = hpText;
        hp.style.display = hpText ? "" : "none";
      }
    }
    for (const [id, el] of ui.els) {
      if (keep.has(id)) continue;
      el.remove();
      ui.els.delete(id);
    }
  }

  function ownerName(pid) {
    const pi = page.playersInfo();
    const p = pi && pi[pid];
    return p ? p.users_username : "Player " + pid;
  }

  function renderPanel() {
    if (!ui.panel) return;
    const md = mode();
    const list = md.ok ? entries() : [];
    ui.count.textContent = md.ok ? `${list.length} remembered` : "inactive";
    ui.note.textContent = md.msg;
    ui.note.style.display = md.msg ? "" : "none";
    ui.controls.style.display = md.ok ? "" : "none";
    ui.panel.querySelector(".fm-scroll").style.display = md.ok ? "" : "none";
    if (!md.ok) {
      setRows("");
      return;
    }
    setRows(
      list.length
        ? list
            .map((e) => {
              const m = e.m;
              let pos = e.x != null ? `(${e.x},${e.y})` : "?";
              let status = STATUS_TEXT[e.status];
              if (e.status === "carried") {
                status = e.carrier ? `in ${e.carrier.name}` : "carried";
                if (e.carrier && e.carrier.live) pos = `(${e.x},${e.y})`;
                else if (!e.carrier) pos = "?";
              }
              const title = `${m.name} #${e.id} of ${ownerName(m.pid)} — last seen day ${m.day} at (${m.x},${m.y})${m.hp != null ? `, ${m.hp} HP` : ""} — ${STATUS_TEXT[e.status]}`;
              return `<tr data-id="${e.id}" class="fm-r-${e.status}" title="${esc(title)}"><td>${esc(m.name)}</td><td>${esc(ownerName(m.pid))}</td><td>${pos} D${m.day}</td><td>${m.hp != null ? m.hp : "?"}</td><td class="fm-st">${esc(status)}</td></tr>`;
            })
            .join("")
        : `<tr><td colspan="5" class="fm-empty">No remembered enemy units yet. Units you see are remembered once they vanish into fog.</td></tr>`
    );
  }

  // The 1 s poll re-renders; only touch the DOM when rows changed so hover/scroll state survives.
  let lastRows = null;
  function setRows(html) {
    if (html === lastRows) return;
    lastRows = html;
    ui.tbody.innerHTML = html;
  }

  function renderAll() {
    renderMap();
    renderPanel();
  }

  function setHighlight(id) {
    ui.hl = id;
    renderMap();
  }

  function buildUI() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const p = document.createElement("div");
    p.id = "fm-panel";
    if (ui.minimized) p.classList.add("fm-min");
    p.innerHTML = `
      <div class="fm-head"><span class="fm-title">Fog memory</span><span class="fm-count"></span><span class="fm-toggle"></span></div>
      <div class="fm-body">
        <div class="fm-note"></div>
        <div class="fm-controls">
          <label title="Draw faded markers on the map for units that vanished into fog"><input type="checkbox" class="fm-show"> ghosts on map</label>
          <button class="fm-clear" title="Forget every enemy unit remembered for this game">Clear memory</button>
        </div>
        <div class="fm-scroll"><table>
          <thead><tr><th>Unit</th><th>Owner</th><th>Last seen</th><th>HP</th><th>Status</th></tr></thead>
          <tbody></tbody>
        </table></div>
      </div>`;
    // the shared frame mounts the panel into the dock at the end of buildUI
    ui.panel = p;
    ui.tbody = p.querySelector("tbody");
    ui.count = p.querySelector(".fm-count");
    ui.note = p.querySelector(".fm-note");
    ui.controls = p.querySelector(".fm-controls");

    const toggle = p.querySelector(".fm-toggle");
    toggle.textContent = ui.minimized ? "▴" : "▾";
    p.querySelector(".fm-head").addEventListener("click", () => {
      ui.minimized = !ui.minimized;
      p.classList.toggle("fm-min", ui.minimized);
      toggle.textContent = ui.minimized ? "▴" : "▾";
      localStorage.setItem("awbw-fm:min", ui.minimized ? "1" : "0");
    });
    const show = p.querySelector(".fm-show");
    show.checked = ui.show;
    show.addEventListener("change", () => {
      ui.show = show.checked;
      localStorage.setItem("awbw-fm:show", ui.show ? "1" : "0");
      renderMap();
    });
    p.querySelector(".fm-clear").addEventListener("click", () => {
      if (!confirm("Forget all enemy units remembered for this game?")) return;
      clearGameMemory();
      reconcile(); // visible units are remembered again right away; hidden ones are gone
      renderAll();
    });
    ui.tbody.addEventListener("mouseover", (e) => {
      const tr = e.target.closest && e.target.closest("tr[data-id]");
      const id = tr ? +tr.getAttribute("data-id") : null;
      if (id !== ui.hl) setHighlight(id);
    });
    ui.tbody.addEventListener("mouseleave", () => setHighlight(null));
    awbwMountPanel({ key: "fm", panel: p, header: p.querySelector(".fm-head"), onEnabled: setEnabled });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function onFatal(err) {
    console.error(LOG, err);
  }

  loadMem();
  buildUI();
  reconcile();
  renderAll();
  window.addEventListener("beforeunload", () => {
    if (enabled && S.dirty) saveNow();
  });

  // Hooks first (game.js may still be initialising), then a slow poll as backstop for fog changes that arrive
  // without an action of their own (delayed deletions, Sonja/CO vision effects, reconnect resync).
  (async () => {
    for (let i = 0; i < 50 && !installHooks(); i++) await sleep(200);
    if (!window.actionHandlers) console.warn(LOG, "actionHandlers not found; live updates disabled (polling only)");
    setInterval(() => {
      if (!enabled) return;
      try {
        reconcile();
        renderAll();
      } catch (err) {
        onFatal(err);
      }
    }, POLL_MS);
  })().catch(onFatal);
})();
