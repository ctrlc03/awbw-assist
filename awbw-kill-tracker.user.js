// ==UserScript==
// @name         AWBW Unit Kill Tracker
// @namespace    awbw-kill-tracker
// @version      1.2.0
// @description  Tracks kills and damage dealt per unit on Advance Wars By Web (ongoing and finished games).
// @homepageURL  https://github.com/ctrlc03/awbw-assist
// @supportURL   https://github.com/ctrlc03/awbw-assist/issues
// @updateURL    https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-kill-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-kill-tracker.user.js
// @match        https://awbw.amarriner.com/game.php*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Core: turns replay actions into combat events. Pure, no DOM.
  // ---------------------------------------------------------------------------
  //
  // Engine state: { units: { [id]: { hp, x, y, carried, pid } }, meta, teams }
  //   hp is the displayed HP (1..10) or null when hidden by fog.
  // Events (compact arrays, cheap to cache):
  //   ["f", attId, defId, attPre, attPost, defPre, defPost]   attack + counter
  //   ["a", sourceId, targetId, pre, post]                   black bomb / silo
  //   ["j", fromId, intoId]                                  join (stats carry over)

  const num = (v) => (typeof v === "number" ? v : v === "" || v == null || v === "?" || isNaN(+v) ? null : +v);
  const uid = (u) => (u && u !== "?" && u.units_id != null && u.units_id !== "?" ? +u.units_id : null);

  function newState(teams) {
    return { units: {}, meta: {}, teams: teams || {} };
  }

  // Adds or updates a unit from a (possibly partial) unit object.
  function upsert(st, u) {
    const id = uid(u);
    if (id == null) return null;
    const cur = st.units[id] || (st.units[id] = { hp: null, x: null, y: null, carried: false, pid: null });
    if ("units_hit_points" in u) cur.hp = num(u.units_hit_points);
    if ("units_x" in u) cur.x = num(u.units_x);
    if ("units_y" in u) cur.y = num(u.units_y);
    if ("units_carried" in u) cur.carried = u.units_carried === "Y";
    if (u.units_players_id != null) cur.pid = +u.units_players_id;
    if (u.units_name) {
      st.meta[id] = [u.units_name, cur.pid, num(u.units_cost) || 0];
    } else if (st.meta[id] && cur.pid != null) {
      st.meta[id][1] = cur.pid;
    }
    return cur;
  }

  function stateFromUnits(unitsObj, teams) {
    const st = newState(teams);
    for (const k in unitsObj || {}) upsert(st, unitsObj[k]);
    return st;
  }

  function teamOf(st, id) {
    const u = st.units[id];
    const pid = u ? u.pid : st.meta[id] ? st.meta[id][1] : null;
    return pid == null ? null : st.teams[pid] != null ? String(st.teams[pid]) : String(pid);
  }

  // Black bomb / missile silo: units in Manhattan radius lose HP, never below 1.
  function areaDamage(st, sourceId, x, y, radius, loss, emit) {
    const srcTeam = sourceId != null ? teamOf(st, sourceId) : null;
    for (const k in st.units) {
      const u = st.units[k];
      if (u.carried || u.x == null || u.y == null) continue;
      if (Math.abs(u.x - x) + Math.abs(u.y - y) > radius) continue;
      if (u.hp == null) continue;
      const pre = u.hp;
      const post = Math.max(1, pre - loss);
      u.hp = post;
      if (sourceId != null && post !== pre && teamOf(st, +k) !== srcTeam) emit(["a", sourceId, +k, pre, post]);
    }
  }

  function unitAt(st, x, y) {
    for (const k in st.units) {
      const u = st.units[k];
      if (!u.carried && u.x === x && u.y === y) return +k;
    }
    return null;
  }

  function applyAction(st, a, emit) {
    switch (a.action) {
      case "Fire": {
        const aId = uid(a.attacker);
        const dId = uid(a.defender);
        const aPre = aId != null && st.units[aId] ? st.units[aId].hp : null;
        const dPre = dId != null && st.units[dId] ? st.units[dId].hp : null;
        const aPost = aId != null ? num(a.attacker.units_hit_points) : null;
        const dPost = dId != null ? num(a.defender.units_hit_points) : null;
        if (aId != null || dId != null) emit(["f", aId, dId, aPre, aPost, dPre, dPost]);
        if (aId != null) upsert(st, a.attacker);
        if (dId != null) upsert(st, a.defender);
        if (aPost === 0) delete st.units[aId];
        if (dPost === 0) delete st.units[dId];
        break;
      }
      case "AttackSeam":
        if (uid(a.attacker) != null) upsert(st, a.attacker);
        break;
      case "Move": {
        const u = upsert(st, a.unit);
        const end = a.path && a.path[a.path.length - 1];
        if (u && end) {
          u.x = num(end.x);
          u.y = num(end.y);
        }
        break;
      }
      case "Build":
        upsert(st, a.newUnit);
        break;
      case "Load": {
        const u = st.units[+a.loadedId];
        if (u) u.carried = true;
        break;
      }
      case "Unload": {
        const u = upsert(st, a.unloadedUnit);
        if (u) u.carried = false;
        break;
      }
      case "Join": {
        const from = +a.joinId;
        const into = uid(a.joinedUnit);
        delete st.units[from];
        if (into != null) {
          upsert(st, a.joinedUnit);
          emit(["j", from, into]);
        }
        break;
      }
      case "Repair":
        if (a.repairedUnit) upsert(st, a.repairedUnit);
        break;
      case "Delete":
        delete st.units[+a.deletedId];
        break;
      case "Explode": {
        const bomb = +a.unitId;
        delete st.units[bomb];
        areaDamage(st, bomb, num(a.explosionX), num(a.explosionY), 3, 5, emit);
        break;
      }
      case "Launch": {
        const launcher = unitAt(st, num(a.siloX), num(a.siloY));
        areaDamage(st, launcher, num(a.targetX), num(a.targetY), 2, 3, emit);
        break;
      }
      case "Power": {
        const hc = a.hpChange;
        if (hc && hc.hpLoss) {
          const players = (hc.hpLoss.players || []).map(Number);
          for (const k in st.units) {
            const u = st.units[k];
            if (u.carried || u.hp == null || !players.includes(u.pid)) continue;
            u.hp = Math.max(1, Math.min(10, u.hp + num(hc.hpLoss.hp)));
          }
        }
        if (hc && hc.hpGain) {
          const pid = +a.playerId;
          for (const k in st.units) {
            const u = st.units[k];
            if (u.carried || u.hp == null || u.pid !== pid) continue;
            u.hp = Math.max(1, Math.min(10, u.hp + num(hc.hpGain.hp)));
          }
        }
        const replace = []
          .concat((a.unitReplace && a.unitReplace.units) || [])
          .concat((a.hiddenReplace && a.hiddenReplace.units) || []);
        for (const r of replace) if (st.units[uid(r)]) upsert(st, r);
        if (a.unitAdd && a.unitAdd.units) {
          for (const nu of a.unitAdd.units) {
            const id = uid(nu);
            if (id == null) continue;
            upsert(st, Object.assign({ units_hit_points: 9, units_players_id: a.playerId }, nu));
            if (!st.meta[id] && a.unitAdd.unitName) {
              st.meta[id] = [a.unitAdd.unitName, +a.playerId, a.unitAdd.unitName === "Infantry" ? 1000 : 3000];
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  function teamsFromPlayers(players) {
    const teams = {};
    for (const k in players || {}) teams[+k] = players[k].players_team;
    return teams;
  }

  // One replay turn → { events, meta, state } (state = end-of-turn engine state).
  function simulateTurn(turnData) {
    const gs = turnData.gameState || {};
    const st = stateFromUnits(gs.units, teamsFromPlayers(gs.players));
    const events = [];
    for (const a of turnData.actions || []) applyAction(st, a, (e) => events.push(e));
    return { events, meta: st.meta, state: st };
  }

  function eventKey(e) {
    return e.join("|");
  }

  // Aggregates events into per-unit stats. Joined units fold into the survivor.
  function aggregate(eventLists, meta) {
    const alias = {};
    for (const list of eventLists) for (const e of list) if (e[0] === "j") alias[e[1]] = e[2];
    const root = (id) => {
      let seen = 0;
      while (alias[id] != null && seen++ < 50) id = alias[id];
      return id;
    };
    const stats = {};
    const S = (id) => stats[id] || (stats[id] = { id, kills: 0, dmg: 0, value: 0, counterDmg: 0, unknown: 0, merged: [] });
    const cost = (id) => (meta[id] ? meta[id][2] : 0);
    // Credits `by` for taking `target` from pre to post HP; returns HP removed.
    const hit = (by, target, pre, post) => {
      if (post == null) return 0;
      const s = S(root(by));
      if (post === 0 && pre !== 0) s.kills++;
      if (pre == null) {
        s.unknown++;
        return 0;
      }
      const dealt = Math.max(0, pre - post);
      s.dmg += dealt;
      s.value += (dealt * cost(target)) / 10;
      return dealt;
    };
    for (const list of eventLists) {
      for (const e of list) {
        if (e[0] === "f") {
          const [, att, def, aPre, aPost, dPre, dPost] = e;
          if (att == null || def == null) continue;
          hit(att, def, dPre, dPost);
          const counter = hit(def, att, aPre, aPost);
          if (counter) S(root(def)).counterDmg += counter;
        } else if (e[0] === "a") {
          hit(e[1], e[2], e[3], e[4]);
        } else if (e[0] === "j") {
          S(root(e[2])).merged.push(e[1]);
        }
      }
    }
    return { stats, root };
  }

  if (!document.getElementById("gamemap")) return;

  // ---------------------------------------------------------------------------
  // Page integration
  // ---------------------------------------------------------------------------

  const LOG = "[AWBW kill tracker]";
  const REQUEST_GAP_MS = 350;
  const STORE_PREFIX = "awbw-kt:v1:";
  const STORE_INDEX = "awbw-kt:index";
  const MAX_STORED_GAMES = 30;

  // Page globals declared with let/const are reachable by bare name only (no window property).
  const page = {
    unitsInfo: () => (typeof unitsInfo !== "undefined" ? unitsInfo : null), // eslint-disable-line no-undef
    playersInfo: () => (typeof playersInfo !== "undefined" ? playersInfo : null), // eslint-disable-line no-undef
    viewerPId: () => (typeof viewerPId !== "undefined" ? viewerPId : 0), // eslint-disable-line no-undef
  };
  const GAME_ID = +new URLSearchParams(location.search).get("games_id");
  if (!GAME_ID) return;
  const STORE_KEY = STORE_PREFIX + GAME_ID + ":" + (page.viewerPId() || 0);

  const T = {
    turns: {}, // idx -> Map(key -> event)
    complete: {}, // idx -> true when authoritative and cached
    meta: {}, // unitId -> [name, pid, cost]
    players: {}, // pid -> { name, team }
    currentIdx: -1,
    live: null, // engine state for live actions
    pendingEvents: [], // live events seen before the replay index told us the current turn
    pendingActions: [], // live actions seen before any engine state existed (no page access)
    alive: {}, // unitId -> {x, y}
    stats: {},
    root: (id) => id,
  };

  // ---- persistence ----------------------------------------------------------

  function loadCache() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      Object.assign(T.meta, c.meta || {});
      Object.assign(T.players, c.players || {});
      for (const idx in c.turns || {}) {
        T.turns[idx] = new Map(c.turns[idx].map((e) => [eventKey(e), e]));
        T.complete[idx] = true;
      }
    } catch (err) {
      console.warn(LOG, "cache unreadable, ignoring", err);
    }
  }

  function saveCache() {
    const turns = {};
    for (const idx in T.complete) if (T.turns[idx]) turns[idx] = [...T.turns[idx].values()];
    const payload = JSON.stringify({ meta: T.meta, players: T.players, turns });
    let index = [];
    try {
      index = JSON.parse(localStorage.getItem(STORE_INDEX) || "[]");
    } catch (_) {}
    index = index.filter((k) => k !== STORE_KEY);
    index.push(STORE_KEY);
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
    console.warn(LOG, "could not persist cache (storage full)");
  }

  // Bumped on every wipe; history loads started before it drop their results instead of re-adding them.
  let dataGen = 0;

  function resetData() {
    dataGen++;
    for (const k of Object.keys(T.turns)) delete T.turns[k];
    for (const k of Object.keys(T.complete)) delete T.complete[k];
    T.pendingEvents.length = 0;
  }

  function clearGameData() {
    resetData();
    localStorage.removeItem(STORE_KEY);
    try {
      const index = JSON.parse(localStorage.getItem(STORE_INDEX) || "[]").filter((k) => k !== STORE_KEY);
      localStorage.setItem(STORE_INDEX, JSON.stringify(index));
    } catch (_) {
      localStorage.removeItem(STORE_INDEX);
    }
  }

  // Removes stored history of every game (UI preferences are kept).
  function clearAllData() {
    resetData();
    for (const k of Object.keys(localStorage)) if (k.startsWith(STORE_PREFIX)) localStorage.removeItem(k);
    localStorage.removeItem(STORE_INDEX);
  }

  // ---- network ----------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastRequestAt = 0;
  let requestChain = Promise.resolve();

  // Serialized + spaced: the replay endpoint answers 429 to parallel bursts, and occasionally
  // an HTML page with status 200; both are retried with backoff.
  function loadReplay(turn, initial) {
    const run = async () => {
      let backoff = 2000;
      for (let attempt = 1; ; attempt++) {
        const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
        const res = await fetch("api/game/load_replay.php", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(initial ? { gameId: GAME_ID, turn, initial: true } : { gameId: GAME_ID, turn }),
        });
        if (res.status !== 429 && res.status < 500 && !res.ok) throw new Error(`load_replay turn ${turn}: HTTP ${res.status}`);
        let data = null;
        if (res.ok) {
          try {
            data = JSON.parse(await res.text());
          } catch (_) {}
        }
        if (!data) {
          if (attempt >= 8) throw new Error(`load_replay turn ${turn}: no valid response after ${attempt} attempts`);
          setStatus(`server busy, retrying in ${backoff / 1000}s…`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60000);
          continue;
        }
        if (data.err) throw new Error(`load_replay turn ${turn}: ${data.message || JSON.stringify(data.err)}`);
        return data;
      }
    };
    const p = requestChain.then(run, run);
    requestChain = p.catch(() => {});
    return p;
  }

  // ---- turn bookkeeping -------------------------------------------------------

  function absorbPlayers(players) {
    for (const k in players || {}) {
      const p = players[k];
      T.players[+k] = { name: p.users_username, team: p.players_team };
    }
  }

  function setAliveFromState(st) {
    T.alive = {};
    for (const k in st.units) T.alive[k] = { x: st.units[k].x, y: st.units[k].y };
  }

  // Replay data is authoritative for finished turns; live events for the same turn are merged by key.
  function ingestTurn(idx, data, finished) {
    absorbPlayers(data.gameState && data.gameState.players);
    const sim = simulateTurn(data);
    Object.assign(T.meta, sim.meta);
    const merged = new Map(sim.events.map((e) => [eventKey(e), e]));
    if (T.turns[idx]) for (const [k, e] of T.turns[idx]) if (!merged.has(k)) merged.set(k, e);
    T.turns[idx] = merged;
    if (finished) T.complete[idx] = true;
    else delete T.complete[idx];
    return sim;
  }

  function teamsMap() {
    const teams = {};
    for (const pid in T.players) teams[pid] = T.players[pid].team;
    return teams;
  }

  // Engine for live actions; seeded from the page's own unit table when reachable.
  function syncLiveFromPage() {
    const units = page.unitsInfo();
    if (!units) return false;
    T.live = stateFromUnits(units, teamsMap());
    Object.assign(T.meta, T.live.meta);
    return true;
  }

  function addEvents(idx, events) {
    const bucket = T.turns[idx] || (T.turns[idx] = new Map());
    for (const e of events) bucket.set(eventKey(e), e);
  }

  // Events are computed at once (pre-action HP must be read before game.js mutates it);
  // only the turn they belong to may have to wait for the replay index.
  function recordLive(action) {
    if (!enabled) return;
    if (!syncLiveFromPage() && !T.live) {
      T.pendingActions.push(action);
      return;
    }
    const events = [];
    applyAction(T.live, action, (e) => events.push(e));
    Object.assign(T.meta, T.live.meta);
    setAliveFromState(T.live);
    if (T.currentIdx < 0) T.pendingEvents.push(...events);
    else addEvents(T.currentIdx, events);
    refresh();
  }

  // Called once the replay index is known (and, without page access, once T.live is seeded from the replay).
  function flushPending() {
    if (T.pendingEvents.length) addEvents(T.currentIdx, T.pendingEvents.splice(0));
    for (const a of T.pendingActions.splice(0)) recordLive(a);
  }

  let nextTurnTimer = null;
  function onNextTurn() {
    // Before the replay index arrives the index itself already reflects the new turn.
    if (!enabled || T.currentIdx < 0) return;
    T.currentIdx += 1;
    clearTimeout(nextTurnTimer);
    // Give the server a moment to publish the finished turn, then replace live data with replay data.
    nextTurnTimer = setTimeout(async () => {
      const gen = dataGen;
      try {
        const finishedIdx = T.currentIdx - 1;
        if (finishedIdx >= 0) {
          const data = await loadReplay(finishedIdx);
          if (gen !== dataGen) return;
          ingestTurn(finishedIdx, data, true);
          saveCache();
        }
        if (!page.unitsInfo()) {
          const cur = await loadReplay(T.currentIdx);
          if (gen !== dataGen) return;
          const sim = ingestTurn(T.currentIdx, cur, false);
          T.live = sim.state;
        }
        refresh();
      } catch (err) {
        console.error(LOG, err);
      }
    }, 4000);
  }

  function installHooks() {
    const handlers = window.actionHandlers;
    if (!handlers || handlers.__ktHooked) return !!handlers;
    const tracked = ["Fire", "Move", "Build", "Load", "Unload", "Join", "Repair", "Delete", "Explode", "Launch", "Power", "AttackSeam"];
    for (const name of tracked) {
      const orig = handlers[name];
      if (typeof orig !== "function") continue;
      handlers[name] = function (res) {
        try {
          recordLive(JSON.parse(JSON.stringify(res)));
        } catch (err) {
          console.error(LOG, "live hook failed", err);
        }
        return orig.apply(this, arguments);
      };
    }
    const origNext = handlers.NextTurn;
    if (typeof origNext === "function") {
      handlers.NextTurn = function () {
        const out = origNext.apply(this, arguments);
        try {
          onNextTurn();
        } catch (err) {
          console.error(LOG, err);
        }
        return out;
      };
    }
    handlers.__ktHooked = true;
    return true;
  }

  async function loadHistory() {
    const gen = dataGen;
    setStatus("loading replay index…");
    const first = await loadReplay(0, true);
    const days = first.daySelector || [];
    const last = days.length - 1;
    T.currentIdx = last;
    absorbPlayers(first.gameState && first.gameState.players);
    if (gen !== dataGen) {
      // Wiped while loading: keep tracking new combat, skip the history.
      flushPending();
      return;
    }
    const onLatest = (sim) => {
      if (syncLiveFromPage()) {
        setAliveFromState(T.live);
      } else {
        T.live = sim.state;
        setAliveFromState(sim.state);
      }
      flushPending();
    };
    if (!T.complete[0] || last === 0) {
      const sim = ingestTurn(0, first, last > 0);
      if (last === 0) onLatest(sim);
    }
    refresh();
    for (let idx = 1; idx <= last; idx++) {
      if (!enabled) break; // switched off: keep what was loaded, stop fetching
      if (T.complete[idx] && idx !== last) continue;
      setStatus(`loading turn ${idx + 1}/${days.length}…`);
      const data = await loadReplay(idx);
      if (gen !== dataGen) return;
      const sim = ingestTurn(idx, data, idx < last);
      if (idx === last) onLatest(sim);
      if (idx % 10 === 0) saveCache();
      refresh();
    }
    saveCache();
    setStatus("");
    refresh();
  }

  // Off = no badges, no tooltip, no live recording, no network; history resumes from cache when switched on.
  let enabled = false;
  function setEnabled(on) {
    enabled = on;
    if (!on) {
      showTip(null);
      highlight(null);
    }
    refresh();
    if (on) hooksReady.then(runHistory).catch(onFatal);
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
  .kt-badge{position:absolute;top:-3px;font:bold 7px/8px Verdana,sans-serif;color:#fff;padding:0 1px;border-radius:2px;
    z-index:5;pointer-events:none;text-shadow:none;letter-spacing:-.2px}
  .kt-badge-k{left:-2px;background:#c0161c}
  .kt-badge-d{right:-2px;background:#1d4f9c}
  .kt-hl{outline:2px solid #ffd400;outline-offset:-1px;z-index:200!important}
  #kt-panel{width:420px;max-height:60vh;display:flex;flex-direction:column;
    background:#fff;color:#222;border:1px solid #888;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px Verdana,sans-serif}
  #kt-panel.kt-min .kt-body{display:none}
  #kt-panel .kt-head{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#2c3e66;color:#fff;border-radius:5px 5px 0 0;cursor:pointer;user-select:none}
  #kt-panel.kt-min .kt-head{border-radius:5px}
  #kt-panel .kt-title{font-weight:bold;flex:1}
  #kt-panel .kt-status{font-size:10px;opacity:.85}
  #kt-panel .kt-body{display:flex;flex-direction:column;min-height:0}
  #kt-panel .kt-controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #ddd}
  #kt-panel .kt-controls select,#kt-panel .kt-controls button{font-size:11px}
  #kt-panel .kt-actions{display:flex;gap:6px;width:100%}
  #kt-panel .kt-scroll{overflow:auto;min-height:0}
  #kt-panel table{border-collapse:collapse;width:100%}
  #kt-panel th{position:sticky;top:0;background:#eef1f7;cursor:pointer;font-size:11px;text-align:right;padding:3px 5px}
  #kt-panel th:first-child,#kt-panel td:first-child,#kt-panel th:nth-child(2),#kt-panel td:nth-child(2){text-align:left}
  #kt-panel td{padding:2px 5px;text-align:right;border-top:1px solid #f0f0f0;white-space:nowrap}
  #kt-panel tr.kt-dead td{color:#999}
  #kt-panel tbody tr:hover td{background:#fff6c8}
  #kt-panel .kt-totals td{font-weight:bold;background:#f6f6f6}
  #kt-tip{position:fixed;z-index:100001;background:rgba(20,24,40,.92);color:#fff;font:11px Verdana,sans-serif;padding:4px 7px;border-radius:4px;pointer-events:none;display:none;white-space:nowrap}
  `;

  const ui = {
    rebuild: null,
    tbody: null,
    status: null,
    playerSel: null,
    tip: null,
    sort: localStorage.getItem("awbw-kt:sort") || "kills",
    showDead: localStorage.getItem("awbw-kt:showDead") !== "0",
    badges: localStorage.getItem("awbw-kt:badges") !== "0",
    minimized: localStorage.getItem("awbw-kt:min") === "1",
  };

  const fmtValue = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 100000 ? 0 : 1) + "k" : String(Math.round(v)));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function setStatus(s) {
    ui.status.textContent = s;
  }

  let historyRunning = false;
  async function runHistory() {
    if (historyRunning) return;
    historyRunning = true;
    ui.rebuild.disabled = true;
    try {
      await loadHistory();
    } catch (err) {
      onFatal(err);
    } finally {
      historyRunning = false;
      ui.rebuild.disabled = false;
    }
  }

  function buildUI() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const p = document.createElement("div");
    p.id = "kt-panel";
    if (ui.minimized) p.classList.add("kt-min");
    p.innerHTML = `
      <div class="kt-head"><span class="kt-title">Kill tracker</span><span class="kt-status"></span><span class="kt-toggle"></span></div>
      <div class="kt-body">
        <div class="kt-controls">
          <select class="kt-player"><option value="">All players</option></select>
          <label><input type="checkbox" class="kt-dead"> dead</label>
          <label><input type="checkbox" class="kt-badges"> badges</label>
          <span class="kt-actions">
            <button class="kt-rebuild" title="Discard this game's stored history and reload it from the replay">Rebuild</button>
            <button class="kt-clear" title="Delete this game's stored kills/damage. New combat is still tracked.">Clear game data</button>
            <button class="kt-clear-all" title="Delete stored kills/damage for every game">Clear all games</button>
          </span>
        </div>
        <div class="kt-scroll"><table>
          <thead><tr>
            <th data-sort="name">Unit</th><th data-sort="player">Player</th>
            <th data-sort="kills" title="Units destroyed (attacks and counterattacks)">Kills</th>
            <th data-sort="dmg" title="HP removed from enemies (attacks + counters)">Dmg HP</th>
            <th data-sort="value" title="Funds value of HP removed">Value</th>
          </tr></thead>
          <tbody></tbody>
        </table></div>
      </div>`;
    ui.tbody = p.querySelector("tbody");
    ui.status = p.querySelector(".kt-status");
    ui.playerSel = p.querySelector(".kt-player");
    ui.rebuild = p.querySelector(".kt-rebuild");
    const toggle = p.querySelector(".kt-toggle");
    toggle.textContent = ui.minimized ? "▴" : "▾";
    p.querySelector(".kt-head").addEventListener("click", () => {
      ui.minimized = !ui.minimized;
      p.classList.toggle("kt-min", ui.minimized);
      toggle.textContent = ui.minimized ? "▴" : "▾";
      localStorage.setItem("awbw-kt:min", ui.minimized ? "1" : "0");
    });
    const dead = p.querySelector(".kt-dead");
    dead.checked = ui.showDead;
    dead.addEventListener("change", () => {
      ui.showDead = dead.checked;
      localStorage.setItem("awbw-kt:showDead", ui.showDead ? "1" : "0");
      renderTable();
    });
    const badges = p.querySelector(".kt-badges");
    badges.checked = ui.badges;
    badges.addEventListener("change", () => {
      ui.badges = badges.checked;
      localStorage.setItem("awbw-kt:badges", ui.badges ? "1" : "0");
      renderBadges();
    });
    ui.playerSel.addEventListener("change", renderTable);
    p.querySelector("thead").addEventListener("click", (e) => {
      const key = e.target.getAttribute("data-sort");
      if (!key) return;
      ui.sort = key;
      localStorage.setItem("awbw-kt:sort", key);
      renderTable();
    });
    ui.rebuild.addEventListener("click", () => {
      if (historyRunning) return;
      clearGameData();
      refresh();
      runHistory();
    });
    const afterClear = () => {
      refresh();
      setStatus("data cleared · Rebuild reloads history");
    };
    p.querySelector(".kt-clear").addEventListener("click", () => {
      if (!confirm("Delete all kill/damage data stored for this game?")) return;
      clearGameData();
      afterClear();
    });
    p.querySelector(".kt-clear-all").addEventListener("click", () => {
      if (!confirm("Delete kill/damage data stored for ALL games?")) return;
      clearAllData();
      afterClear();
    });
    ui.tbody.addEventListener("mouseover", (e) => {
      const tr = e.target.closest("tr[data-id]");
      highlight(tr ? tr.getAttribute("data-id") : null);
    });
    ui.tbody.addEventListener("mouseleave", () => highlight(null));

    ui.tip = document.createElement("div");
    ui.tip.id = "kt-tip";
    document.body.appendChild(ui.tip);
    const map = document.getElementById("gamemap");
    map.addEventListener("mouseover", (e) => {
      const span = e.target.closest && e.target.closest("span[data-unit-id]");
      showTip(span ? span.getAttribute("data-unit-id") : null, e);
    });
    map.addEventListener("mousemove", (e) => {
      if (ui.tip.style.display === "block") placeTip(e);
    });
    map.addEventListener("mouseleave", () => showTip(null));
    new MutationObserver(scheduleBadges).observe(map, { childList: true, subtree: true });
    awbwMountPanel({ key: "kt", panel: p, header: p.querySelector(".kt-head"), onEnabled: setEnabled });
  }

  let highlighted = null;
  function highlight(id) {
    if (highlighted) highlighted.classList.remove("kt-hl");
    highlighted = id ? document.querySelector(`#gamemap span[data-unit-id='${id}']`) : null;
    if (highlighted) highlighted.classList.add("kt-hl");
  }

  function unitLabel(id) {
    const m = T.meta[id];
    return m ? m[0] : "Unit #" + id;
  }
  function playerName(id) {
    const m = T.meta[id];
    const p = m && T.players[m[1]];
    return p ? p.name : "?";
  }

  function statLine(s) {
    const parts = [`☠ ${s.kills} kill${s.kills === 1 ? "" : "s"}`, `${s.dmg} HP dealt`, `${fmtValue(s.value)} value`];
    if (s.counterDmg) parts.push(`(${s.counterDmg} HP on counters)`);
    return parts.join(" · ");
  }

  function showTip(id, e) {
    if (!id || !enabled) {
      ui.tip.style.display = "none";
      return;
    }
    const s = T.stats[T.root(+id)];
    ui.tip.textContent = `${unitLabel(+id)} — ${s ? statLine(s) : "no combat yet"}`;
    ui.tip.style.display = "block";
    placeTip(e);
  }
  function placeTip(e) {
    ui.tip.style.left = e.clientX + 14 + "px";
    ui.tip.style.top = e.clientY + 14 + "px";
  }

  let badgeFrame = 0;
  function scheduleBadges(mutations) {
    if (mutations && mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.classList && n.classList.contains("kt-badge")))) return;
    if (badgeFrame) return;
    badgeFrame = requestAnimationFrame(() => {
      badgeFrame = 0;
      renderBadges();
    });
  }

  function setBadge(span, cls, text) {
    let b = span.querySelector(":scope > ." + cls);
    if (!text) {
      if (b) b.remove();
      return;
    }
    if (!b) {
      b = document.createElement("span");
      b.className = "kt-badge " + cls;
      span.appendChild(b);
    }
    if (b.textContent !== text) b.textContent = text;
  }

  function renderBadges() {
    for (const span of document.querySelectorAll("#gamemap span[data-unit-id]")) {
      const s = ui.badges && enabled ? T.stats[T.root(+span.getAttribute("data-unit-id"))] : null;
      setBadge(span, "kt-badge-k", s && s.kills ? String(s.kills) : "");
      setBadge(span, "kt-badge-d", s && s.dmg ? String(s.dmg) : "");
    }
  }

  function renderPlayers() {
    const sel = ui.playerSel;
    const have = new Set([...sel.options].map((o) => o.value));
    for (const pid in T.players) {
      if (have.has(pid)) continue;
      const o = document.createElement("option");
      o.value = pid;
      o.textContent = T.players[pid].name;
      sel.appendChild(o);
    }
  }

  function renderTable() {
    const filter = ui.playerSel.value;
    const rows = [];
    for (const id in T.stats) {
      const s = T.stats[id];
      const m = T.meta[id];
      if (filter && (!m || String(m[1]) !== filter)) continue;
      const alive = !!T.alive[id];
      if (!alive && !ui.showDead) continue;
      if (!s.kills && !s.dmg) continue;
      rows.push({ s, id, alive, name: unitLabel(+id), player: playerName(+id) });
    }
    const key = ui.sort;
    rows.sort((a, b) => {
      if (key === "name" || key === "player") return a[key].localeCompare(b[key]) || b.s.kills - a.s.kills;
      return b.s[key] - a.s[key] || b.s.dmg - a.s.dmg;
    });
    const tot = rows.reduce((t, r) => ((t.k += r.s.kills), (t.d += r.s.dmg), (t.v += r.s.value), t), { k: 0, d: 0, v: 0 });
    ui.tbody.innerHTML =
      rows
        .map((r) => {
          const pos = T.alive[r.id] && T.alive[r.id].x != null ? ` <small>(${T.alive[r.id].x},${T.alive[r.id].y})</small>` : "";
          const dead = r.alive ? "" : " †";
          const title = `${r.name} #${r.id}${r.s.merged.length ? " — includes joined unit(s)" : ""}${
            r.s.unknown ? ` — ${r.s.unknown} hit(s) with unknown HP (fog)` : ""
          }`;
          return `<tr data-id="${r.id}" class="${r.alive ? "" : "kt-dead"}" title="${esc(title)}">
            <td>${esc(r.name)}${dead}${pos}</td><td>${esc(r.player)}</td>
            <td>${r.s.kills}</td><td>${r.s.dmg}${r.s.unknown ? "+" : ""}</td><td>${fmtValue(r.s.value)}</td></tr>`;
        })
        .join("") +
      (rows.length
        ? `<tr class="kt-totals"><td colspan="2">Total (${rows.length} units)</td><td>${tot.k}</td><td>${tot.d}</td><td>${fmtValue(tot.v)}</td></tr>`
        : `<tr><td colspan="5" style="text-align:center;color:#888">No combat recorded yet</td></tr>`);
  }

  let refreshQueued = false;
  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      const lists = Object.keys(T.turns)
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => [...T.turns[i].values()]);
      const agg = aggregate(lists, T.meta);
      T.stats = agg.stats;
      T.root = agg.root;
      renderPlayers();
      renderTable();
      renderBadges();
    });
  }

  function onFatal(err) {
    console.error(LOG, err);
    setStatus("error: " + err.message);
  }

  // ---- boot -------------------------------------------------------------------

  loadCache();
  const pi = page.playersInfo();
  if (pi) absorbPlayers(pi);
  // Hooks first so nothing played while history loads is missed; game.js may still be initialising.
  const hooksReady = (async () => {
    for (let i = 0; i < 50 && !installHooks(); i++) await sleep(200);
    if (!window.actionHandlers) console.warn(LOG, "actionHandlers not found; live updates disabled");
  })();
  buildUI(); // mounting the panel calls setEnabled with the remembered on/off state
})();
