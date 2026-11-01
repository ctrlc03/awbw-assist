// ==UserScript==
// @name         AWBW CO Power Planner
// @namespace    awbw-co-power-planner
// @version      1.2.0
// @description  Shows every player's CO power meter, COP/SCOP cost, readiness (now / next turn) and the damage still needed to charge, on Advance Wars By Web (ongoing and finished games).
// @homepageURL  https://github.com/ctrlc03/awbw-assist
// @supportURL   https://github.com/ctrlc03/awbw-assist/issues
// @updateURL    https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-co-power-planner.user.js
// @downloadURL  https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-co-power-planner.user.js
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
  // Power meter model (game.js + replay data, see the "How it works" box in the panel)
  //
  // Units: playersInfo[pid].players_co_power is stored in "meter units" = 10 x the funds shown on the
  // page's power bar (page: `currentFunds = players_co_power / 10`). One star = 9000 bar-funds at the
  // base cost = 90000 meter units: co_max_power / 90000 = COP stars, co_max_spower / 90000 = SCOP stars
  // (SCOP stars are the total, not the extra stars over COP).
  //   players_co_max_power / players_co_max_spower = CURRENT cost (negative = that power disabled).
  //
  // Cost growth (game.js updateCopValues / powerHandler): after every power use (COP or SCOP)
  //   cost = min(stars * 270000, cost + stars * 18000)        (each of COP and SCOP with its own stars)
  // i.e. +20% of the base cost per use, at most 3x the base cost.
  // Using a power sets players_co_power = copValue from the Power action (= meter - cost paid).
  //
  // Charge per Fire (fitted on 4 real games, 0 residual on ~600 meter updates; formulas below):
  //   value(loss) = HP lost x unit cost x CO cost multiplier of the unit's OWNER
  //                 (Kanbei 1.2, Colin 0.8, Hachi 0.9, Hachi while powered 0.5, everyone else 1)
  //   attacker meter += value(attacker units' HP loss) + 0.5 x value(defender units' HP loss)
  //   defender meter += value(defender units' HP loss) + 0.5 x value(attacker units' HP loss)
  //   (HP loss of one display HP of a 1000-cost unit = 1000 meter units = 100 bar-funds)
  //   - no change at all while the player's own power is active
  //   - clamped at the current SCOP cost
  //   - a tag CO's meter gains half of what the main CO gains (floor), same clamp with its own SCOP cost
  // So in BAR funds (what the page prints): 1 fund of damage TAKEN = +1 bar fund, 1 fund of damage DEALT = +0.5.
  // ---------------------------------------------------------------------------

  if (!document.getElementById("gamemap")) return;
  // Move Planner (moveplanner.php?games_id=N): sandbox copy of a game, no game.js, no live actions, no turn/viewer globals.
  const MP = /\/moveplanner\.php$/.test(location.pathname);
  if (MP && !new URLSearchParams(location.search).get("games_id")) return; // maps_id planner: no game data

  const LOG = "[AWBW co power planner]";
  const PREFIX = "awbw-cp:";
  const STAR_RAW = 90000; // meter units per base star
  const COST_MULT = { Kanbei: 1.2, Colin: 0.8, Hachi: 0.9 }; // value multiplier of the owner's units (game.js findCostMultiplier)

  // Page globals declared with let/const are reachable by bare name only (no window property).
  const G = {
    playersInfo: () => (typeof playersInfo !== "undefined" ? playersInfo : null), // eslint-disable-line no-undef
    tagsInfo: () => (typeof tagsInfo !== "undefined" ? tagsInfo : null), // eslint-disable-line no-undef
    currentTurn: () => (typeof currentTurn !== "undefined" ? currentTurn : null), // eslint-disable-line no-undef
    viewerPId: () => (typeof viewerPId !== "undefined" ? viewerPId : 0), // eslint-disable-line no-undef
    gameCop: () => (typeof gameCop !== "undefined" ? gameCop : "Y"), // eslint-disable-line no-undef
    gameEnded: () => !!(typeof gameEndDate !== "undefined" && gameEndDate), // eslint-disable-line no-undef
    unitsInfo: () => (typeof unitsInfo !== "undefined" ? unitsInfo : null), // eslint-disable-line no-undef
  };

  const num = (v) => (typeof v === "number" ? v : isNaN(+v) ? 0 : +v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // Exact bar funds as the page prints them (players_co_power / 10).
  const exact = (rawMeter) => (Math.round(rawMeter) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const fmt = (v) => {
    const a = Math.abs(v);
    if (a >= 100000) return Math.round(v / 1000) + "k";
    if (a >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(v));
  };
  const ls = {
    get: (k, d) => {
      try {
        const v = localStorage.getItem(PREFIX + k);
        return v == null ? d : v;
      } catch (_) {
        return d;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(PREFIX + k, v);
      } catch (_) {}
    },
  };

  // ---- pure model ---------------------------------------------------------------

  // Next cost of a power after one more use (game.js updateCopValues).
  function grownCost(cost, stars) {
    return Math.min(stars * 270000, cost + stars * 18000);
  }

  // State of one CO slot (main entry of playersInfo or tag entry of tagsInfo).
  function coState(p, kind, mainName) {
    const copRaw = num(p.players_co_max_power);
    const scopRaw = num(p.players_co_max_spower);
    const copStars = num(p.co_max_power) / STAR_RAW;
    const scopStars = num(p.co_max_spower) / STAR_RAW;
    return {
      kind,
      name: p.co_name || "?",
      meter: num(p.players_co_power),
      cop: Math.abs(copRaw),
      scop: Math.abs(scopRaw),
      copStars,
      scopStars,
      copDisabled: copRaw < 0 || p.co_name === "Von Bolt" || copStars <= 0,
      scopDisabled: scopRaw < 0 || scopStars <= 0,
      on: kind === "main" ? p.players_co_power_on || "N" : "N",
      // value of 1 star in bar funds at the current cost (page: findStarValue)
      starFunds: num(p.co_max_spower) > 0 ? (Math.abs(scopRaw) / num(p.co_max_spower)) * 9000 : 9000,
      valueMult: COST_MULT[mainName] || 1,
    };
  }

  // Remaining meter units and the damage (in funds) that would cover them.
  // main meter: dealt x0.5 + taken x1 (bar funds); tag meter: half of that.
  function damageNeeded(co, costRaw) {
    const needRaw = Math.max(0, costRaw - co.meter);
    const bar = needRaw / 10;
    const k = co.kind === "tag" ? 2 : 1;
    return { needRaw, bar, dealt: bar * 2 * k, taken: (bar * k) / co.valueMult };
  }

  function readPlayers() {
    const pi = G.playersInfo();
    if (!pi) return null;
    const ti = G.tagsInfo();
    const cur = G.currentTurn();
    const viewer = G.viewerPId();
    const ended = G.gameEnded();
    const viewerTeam = viewer && pi[viewer] ? String(pi[viewer].players_team) : null;
    const list = [];
    for (const k in pi) {
      const p = pi[k];
      if (!p || p.players_id == null) continue;
      const pid = +p.players_id;
      const main = coState(p, "main", p.co_name);
      const tagRaw = ti && typeof ti === "object" ? ti[k] : null;
      const tag = tagRaw && tagRaw.co_name ? coState(tagRaw, "tag", p.co_name) : null;
      const eliminated = p.players_eliminated === "Y";
      const isTurn = cur != null && pid === +cur;
      const copReady = !main.copDisabled && main.on === "N" && main.meter >= main.cop;
      const scopReady = !main.scopDisabled && main.on === "N" && main.meter >= main.scop;
      // After an active power ends (start of the owner's next turn) leftover meter may allow another one at once.
      const copNext = !main.copDisabled && main.meter >= main.cop;
      const scopNext = !main.scopDisabled && main.meter >= main.scop;
      const tagCopReady = !!tag && !tag.copDisabled && tag.meter >= tag.cop;
      const tagScopReady = !!tag && !tag.scopDisabled && tag.meter >= tag.scop;
      const mine = viewer ? pid === +viewer : false;
      const enemy = viewer ? !mine && String(p.players_team) !== viewerTeam : true; // spectators: everyone counts
      list.push({
        pid,
        name: p.users_username || "Player " + pid,
        team: String(p.players_team),
        order: num(p.players_order),
        eliminated,
        isTurn: isTurn && !ended,
        ended,
        mp: MP,
        mine,
        enemy,
        main,
        tag,
        copReady,
        scopReady,
        copNext,
        scopNext,
        tagCopReady,
        tagScopReady,
        // value multiplier of this player's units for charge purposes (Hachi: 0.5 while his power is on)
        vmult: main.name === "Hachi" ? (main.on !== "N" ? 0.5 : 0.9) : COST_MULT[main.name] || 1,
        // a power can be activated at the start of the owner's next turn
        threat: !ended && !MP && !eliminated && (copNext || scopNext),
      });
    }
    list.sort((a, b) => a.order - b.order || a.pid - b.pid);
    return list;
  }

  const signature = (list, cop) => JSON.stringify([cop, list && list.map((p) => [p.pid, p.isTurn, p.eliminated, p.main.name, p.main.meter, p.main.on, p.main.cop, p.main.scop, p.tag && [p.tag.name, p.tag.meter, p.tag.cop, p.tag.scop]])]);

  // ---- UI ------------------------------------------------------------------------

  const css = `
  #cp-panel{display:flex;flex-direction:column;background:#fff;color:#222;border:1px solid #888;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px Verdana,sans-serif;min-height:0}
  #cp-panel.cp-min .cp-body{display:none}
  #cp-panel .cp-head{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#2c3e66;color:#fff;border-radius:5px 5px 0 0;cursor:pointer;user-select:none}
  #cp-panel.cp-min .cp-head{border-radius:5px}
  #cp-panel .cp-title{font-weight:bold;flex:1}
  #cp-panel .cp-status{font-size:10px;opacity:.9}
  #cp-panel .cp-body{display:flex;flex-direction:column;min-height:0}
  #cp-panel .cp-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:5px 8px;border-bottom:1px solid #ddd;font-size:11px}
  #cp-panel .cp-scroll{overflow:auto;max-height:52vh;min-height:0}
  #cp-panel .cp-card{border-left:4px solid #888;border-bottom:1px solid #e6e6e6;padding:4px 6px 5px 6px}
  #cp-panel .cp-card.cp-turn{background:#f4f8ff}
  #cp-panel .cp-card.cp-threat{background:#fff0f0;box-shadow:inset 0 0 0 2px #d33}
  #cp-panel .cp-card.cp-elim{opacity:.5}
  #cp-panel .cp-top{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  #cp-panel .cp-name{font-weight:bold}
  #cp-panel .cp-tag{font-size:10px;color:#fff;background:#888;border-radius:3px;padding:0 3px}
  #cp-panel .cp-chip{font-size:10px;font-weight:bold;border-radius:3px;padding:0 4px;color:#fff;background:#6b7a99;white-space:nowrap}
  #cp-panel .cp-chip.cp-cop{background:#1f8f3a}
  #cp-panel .cp-chip.cp-scop{background:#c07a00}
  #cp-panel .cp-chip.cp-on{background:#7a2bb8}
  #cp-panel .cp-chip.cp-warn{background:#d33}
  #cp-panel .cp-co{margin-top:3px}
  #cp-panel .cp-co.cp-tagco{border-top:1px dashed #ccc;padding-top:3px}
  #cp-panel .cp-coline{display:flex;gap:6px;align-items:baseline}
  #cp-panel .cp-coline b{font-weight:bold}
  #cp-panel .cp-meter{margin-left:auto;font-variant-numeric:tabular-nums}
  #cp-panel .cp-bar{position:relative;height:7px;background:#e2e5ec;border-radius:3px;margin:2px 0 2px 0;overflow:hidden}
  #cp-panel .cp-fill{position:absolute;left:0;top:0;bottom:0;background:#4a78c9}
  #cp-panel .cp-fill.cp-fcop{background:#1f8f3a}
  #cp-panel .cp-fill.cp-fscop{background:#c07a00}
  #cp-panel .cp-fill.cp-fon{background:#7a2bb8}
  #cp-panel .cp-tick{position:absolute;top:0;bottom:0;width:2px;background:#222}
  #cp-panel .cp-pw{font-size:11px;color:#333;line-height:1.35}
  #cp-panel .cp-pw .cp-lbl{display:inline-block;width:38px;font-weight:bold}
  #cp-panel .cp-need{padding-left:38px;color:#444}
  #cp-panel .cp-ok{color:#1f8f3a;font-weight:bold}
  #cp-panel .cp-dim{color:#888}
  #cp-panel .cp-last{font-size:10px;color:#666}
  #cp-panel .cp-empty{padding:8px;text-align:center;color:#888}
  #cp-panel details{padding:4px 8px;font-size:10px;color:#555;border-top:1px solid #ddd}
  #cp-panel details summary{cursor:pointer}
  .cp-pchip{margin-left:6px;font:bold 10px/14px Verdana,sans-serif;border-radius:3px;padding:0 4px;color:#fff;background:rgba(0,0,0,.55);white-space:nowrap;pointer-events:none}
  .cp-pchip.cp-ready{background:#1f8f3a}
  .cp-pchip.cp-ready-scop{background:#c07a00}
  .cp-pchip.cp-on{background:#7a2bb8}
  .cp-pchip.cp-warn{background:#d33;box-shadow:0 0 0 1px #fff}
  #cp-panel .cp-sack{font-size:11px;color:#222;padding:0}
  #cp-panel .cp-sack>summary{padding:4px 8px;font-weight:bold;color:#2c3e66}
  #cp-panel .cp-sbody{padding:2px 8px 6px;max-height:46vh;overflow:auto}
  #cp-panel .cp-srow0{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-bottom:3px}
  #cp-panel .cp-srow0 select{max-width:210px;font-size:11px}
  #cp-panel .cp-srow0 button{font-size:10px}
  #cp-panel .cp-slist{max-height:150px;overflow:auto;border:1px solid #ddd;border-radius:3px;margin:3px 0}
  #cp-panel .cp-su{display:flex;align-items:center;gap:5px;padding:1px 4px;border-bottom:1px solid #f0f0f0}
  #cp-panel .cp-su .cp-sn{font-weight:bold;white-space:nowrap}
  #cp-panel .cp-su .cp-dim{flex:1;font-size:10px}
  #cp-panel .cp-shp{width:3.2em;font-size:11px}
  #cp-panel .cp-sv{width:3.6em;text-align:right;font-variant-numeric:tabular-nums}
  #cp-panel .cp-sside{margin-top:4px;border-top:1px dashed #ccc;padding-top:3px}
  #cp-panel .cp-sen{margin-top:4px;border-top:1px dashed #ccc;padding-top:3px}
  #cp-panel .cp-sen-row{font-size:10px;line-height:1.4}
  #cp-panel .cp-warnrow{color:#d33;font-weight:bold}
  .cp-smark{position:absolute;left:0;top:0;width:16px;height:16px;box-sizing:border-box;border:2px solid #ff2d9b;background:rgba(255,45,155,.28);pointer-events:none;z-index:7}
  `;

  const ui = {
    panel: null,
    body: null,
    status: null,
    minimized: ls.get("min", "0") === "1",
    chips: ls.get("chips", "1") !== "0",
    hideElim: ls.get("hideElim", "1") !== "0",
    last: {}, // pid -> { d: bar funds gained by last Fire, role }
    enabled: true, // switched by the shared panel frame (power button)
    sack: {}, // sack calculator element refs
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

  // Called by the frame at mount and on every power-button toggle. Off = inert: no chips, no rendering, no storage writes.
  function setEnabled(on) {
    ui.enabled = on;
    if (!on) {
      for (const el of document.querySelectorAll(".cp-pchip, .cp-smark")) el.remove();
      return;
    }
    render(true);
    tick();
  }

  function buildUI() {
    const style = document.createElement("style");
    style.id = "cp-style";
    style.textContent = css;
    document.head.appendChild(style);

    const p = document.createElement("div");
    p.id = "cp-panel";
    if (ui.minimized) p.classList.add("cp-min");
    p.innerHTML = `
      <div class="cp-head"><span class="cp-title">CO power planner</span><span class="cp-status"></span><span class="cp-toggle"></span></div>
      <div class="cp-body">
        <div class="cp-controls">
          <label><input type="checkbox" class="cp-chips"> page-list chips</label>
          <label><input type="checkbox" class="cp-elim"> hide eliminated</label>
        </div>
        <div class="cp-scroll"></div>
        <details class="cp-sack"><summary>Sack calculator</summary>
          <div class="cp-sbody">
            <div class="cp-srow0"><select class="cp-spl" title="Player whose units are sacrificed"></select>
              <button class="cp-sall" title="Tick every unit of this player">all</button><button class="cp-snone" title="Clear the selection">none</button>
              <button class="cp-simport" style="display:none" title="Select the units whose HP you lowered or that you deleted in the planner">Import planner changes</button></div>
            <div class="cp-dim">Tick units (or Alt+click them on the map) and set the HP each loses to enemy fire.</div>
            <div class="cp-slist"></div>
            <div class="cp-stot"></div>
          </div>
        </details>
        <details><summary>How it works</summary>
          <div>Meter shown in bar funds (page value). Gain per fight, per side: <b>own HP loss x1 + enemy HP loss x0.5</b>
          (value = HP/10 x unit cost x Kanbei 1.2 / Colin 0.8 / Hachi 0.9). No gain while that player's power is on; capped at SCOP cost;
          tag CO gets half. Each power use raises both costs by 20% of base (max 3x). "dealt" assumes enemy units without a cost modifier;
          "taken" is in the nominal cost of your own units. Numbers are approximate: they ignore HP rounding of the next fight.</div>
        </details>
      </div>`;
    ui.panel = p;
    ui.body = p.querySelector(".cp-scroll");
    ui.status = p.querySelector(".cp-status");
    const toggle = p.querySelector(".cp-toggle");
    toggle.textContent = ui.minimized ? "▴" : "▾";
    p.querySelector(".cp-head").addEventListener("click", () => {
      ui.minimized = !ui.minimized;
      p.classList.toggle("cp-min", ui.minimized);
      toggle.textContent = ui.minimized ? "▴" : "▾";
      ls.set("min", ui.minimized ? "1" : "0");
    });
    const chips = p.querySelector(".cp-chips");
    chips.checked = ui.chips;
    chips.addEventListener("change", () => {
      ui.chips = chips.checked;
      ls.set("chips", ui.chips ? "1" : "0");
      render(true);
    });
    const elim = p.querySelector(".cp-elim");
    elim.checked = ui.hideElim;
    elim.addEventListener("change", () => {
      ui.hideElim = elim.checked;
      ls.set("hideElim", ui.hideElim ? "1" : "0");
      render(true);
    });
    initSackUI(p);
    if (MP) p.querySelector(".cp-chips").parentElement.style.display = "none"; // the planner has no player list
    awbwMountPanel({ key: "cp", panel: p, header: p.querySelector(".cp-head"), onEnabled: setEnabled });
  }

  // "COP 54%" / "COP ✓" parts used by the compact chips.
  const pctOf = (m, cost) => (cost > 0 ? Math.floor((m * 100) / cost) : 0);

  function powerLine(co, which, p) {
    const dis = which === "cop" ? co.copDisabled : co.scopDisabled;
    const cost = which === "cop" ? co.cop : co.scop;
    const stars = which === "cop" ? co.copStars : co.scopStars;
    const label = which === "cop" ? "COP" : "SCOP";
    if (dis) return `<div class="cp-pw"><span class="cp-lbl">${label}</span><span class="cp-dim">not available${co.name === "Von Bolt" && which === "cop" ? " (Von Bolt has no COP)" : ""}</span></div>`;
    const nextCost = grownCost(cost, stars);
    const head = `<span class="cp-lbl" title="Cost after the next use: ${exact(nextCost)}">${label}</span>${exact(cost)} <span class="cp-dim">(${stars}★ · ${pctOf(co.meter, cost)}%)</span> `;
    if (co.meter >= cost) {
      let when = "";
      if (co.kind === "main") {
        if (co.on !== "N") when = p.isTurn || p.mp ? "" : " · chain-usable next turn";
        else when = p.mp ? "" : p.ended ? " · game over" : p.isTurn ? " · usable now" : " · usable on their next turn";
      } else {
        when = " · usable after CO swap";
      }
      return `<div class="cp-pw">${head}<span class="cp-ok">ready${esc(when)}</span></div>`;
    }
    const need = damageNeeded(co, cost);
    return `<div class="cp-pw">${head}</div><div class="cp-pw cp-need">needs ${exact(need.needRaw)} more ≈ <b>${fmt(need.dealt)}</b> dealt OR <b>${fmt(need.taken)}</b> taken</div>`;
  }

  function coBlock(co, p) {
    const maxCost = Math.max(co.scopDisabled ? 0 : co.scop, co.copDisabled ? 0 : co.cop, 1);
    const fillPct = Math.min(100, (co.meter * 100) / maxCost);
    const copTick = !co.copDisabled && co.cop < maxCost ? `<i class="cp-tick" style="left:${((co.cop * 100) / maxCost).toFixed(2)}%"></i>` : "";
    const fcls = co.on !== "N" ? "cp-fon" : !co.scopDisabled && co.meter >= co.scop ? "cp-fscop" : !co.copDisabled && co.meter >= co.cop ? "cp-fcop" : "";
    const extra = co.kind === "tag" ? ` <span class="cp-tag">tag</span>` : "";
    const active = co.on !== "N" ? ` <span class="cp-chip cp-on">${co.on === "Y" ? "COP" : "SCOP"} ACTIVE</span>` : "";
    return `<div class="cp-co ${co.kind === "tag" ? "cp-tagco" : ""}">
      <div class="cp-coline"><b>${esc(co.name)}</b>${extra}${active}<span class="cp-meter" title="players_co_power = ${co.meter}">${exact(co.meter)}</span></div>
      <div class="cp-bar"><div class="cp-fill ${fcls}" style="width:${fillPct.toFixed(1)}%"></div>${copTick}</div>
      ${powerLine(co, "cop", p)}${powerLine(co, "scop", p)}
    </div>`;
  }

  // Header chip for a player: the strongest ready power, an active power, or charge percentages.
  function summaryChip(p) {
    const m = p.main;
    if (m.on !== "N") {
      const chain = p.scopNext ? " · SCOP chain" : p.copNext ? " · COP chain" : "";
      return { cls: "cp-on", text: `${m.on === "Y" ? "COP" : "SCOP"} ON${chain}` };
    }
    if (p.scopReady) return { cls: "cp-ready-scop", text: p.ended || p.mp ? "SCOP ✓" : p.isTurn ? "SCOP READY" : "SCOP next turn" };
    if (p.copReady) {
      const sc = m.scopDisabled ? "" : ` · SCOP ${pctOf(m.meter, m.scop)}%`;
      return { cls: "cp-ready", text: (p.ended || p.mp ? "COP ✓" : p.isTurn ? "COP READY" : "COP next turn") + sc };
    }
    const bits = [];
    if (!m.copDisabled) bits.push(`COP ${pctOf(m.meter, m.cop)}%`);
    if (!m.scopDisabled) bits.push(`SCOP ${pctOf(m.meter, m.scop)}%`);
    return { cls: "", text: bits.join(" · ") || "no powers" };
  }

  // Very short text for the page's narrow player header: ✓ = usable, ON = active, else % of the next power.
  function compactChip(p) {
    const m = p.main;
    if (m.on !== "N") return `${m.on === "Y" ? "COP" : "SCOP"} ON`;
    if (p.scopReady) return "SCOP ✓";
    if (p.copReady) return "COP ✓";
    if (!m.copDisabled) return `COP ${pctOf(m.meter, m.cop)}%`;
    if (!m.scopDisabled) return `SCOP ${pctOf(m.meter, m.scop)}%`;
    return "";
  }

  function playerColor(pid) {
    try {
      const h = document.querySelector("#player" + pid + " .player-overview-header");
      const m = h && /rgb\([^)]*\)/.exec(h.style.background || h.getAttribute("style") || "");
      return m ? m[0] : "#888";
    } catch (_) {
      return "#888";
    }
  }

  function cardHtml(p) {
    const chip = summaryChip(p);
    const threat = p.enemy && p.threat;
    const warn = threat ? `<span class="cp-chip cp-warn" title="Can activate a power at the start of their next turn">⚠ power next turn</span>` : "";
    const last = ui.last[p.pid];
    const lastTxt = last ? `<div class="cp-last">last fight: ${last.d > 0 ? "+" + fmt(last.d) : "no gain"} bar funds as ${last.role}</div>` : "";
    const cls = ["cp-card", p.isTurn ? "cp-turn" : "", threat ? "cp-threat" : "", p.eliminated ? "cp-elim" : ""].join(" ");
    return `<div class="${cls}" data-pid="${p.pid}" style="border-left-color:${esc(playerColor(p.pid))}">
      <div class="cp-top"><span class="cp-name">${p.isTurn ? "▶ " : ""}${esc(p.name)}${p.mine ? " (you)" : ""}</span>
        <span class="cp-chip ${chip.cls}">${esc(chip.text)}</span>${warn}</div>
      ${coBlock(p.main, p)}${p.tag ? coBlock(p.tag, p) : ""}${lastTxt}
    </div>`;
  }

  // Compact chip next to the username in the page's player list.
  function renderChips(list) {
    if (MP) return;
    for (const el of document.querySelectorAll(".cp-pchip")) if (!ui.chips || !list) el.remove();
    if (!ui.chips || !list) return;
    for (const p of list) {
      const header = document.querySelector("#player" + p.pid + " .player-overview-header");
      if (!header) continue;
      let el = header.querySelector(":scope > .cp-pchip");
      if (!el) {
        el = document.createElement("span");
        el.className = "cp-pchip";
        const name = header.querySelector(".player-username");
        if (name && name.nextSibling) header.insertBefore(el, name.nextSibling);
        else header.appendChild(el);
      }
      const chip = summaryChip(p);
      const short = compactChip(p);
      const threat = p.enemy && p.threat;
      const cls = "cp-pchip " + chip.cls + (threat ? " cp-warn" : "");
      const text = (threat ? "⚠" : "") + short;
      if (el.className !== cls) el.className = cls;
      if (el.textContent !== text) el.textContent = text;
      const title = chip.text + " (CO power planner)";
      if (el.title !== title) el.title = title;
    }
  }

  let lastSig = "";
  function render(force) {
    if (!ui.enabled) return;
    const list = readPlayers();
    const cop = G.gameCop();
    const sig = signature(list, cop) + "|" + JSON.stringify(ui.last) + ui.hideElim + ui.chips;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    if (!list) {
      ui.body.innerHTML = `<div class="cp-empty">Page state not available.</div>`;
      return;
    }
    if (cop === "N") {
      ui.body.innerHTML = `<div class="cp-empty">CO powers are disabled in this game.</div>`;
      ui.status.textContent = "";
      renderChips(null);
      return;
    }
    const shown = list.filter((p) => !(ui.hideElim && p.eliminated));
    ui.body.innerHTML = shown.length ? shown.map(cardHtml).join("") : `<div class="cp-empty">No players.</div>`;
    const threats = list.filter((p) => p.enemy && p.threat).length;
    ui.status.textContent = threats ? `⚠ ${threats} power${threats > 1 ? "s" : ""} ready` : "";
    renderChips(list);
  }

  let frame = 0;
  function schedule() {
    if (!ui.enabled || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      try {
        tick();
      } catch (err) {
        console.error(LOG, err);
      }
    });
  }

  // ---- sack calculator -----------------------------------------------------------------
  // What-if: the ticked units of one player are destroyed by ENEMY FIRE, each losing the given HP.
  // Charge rules = the fitted Fire rules in the header comment:
  //   raw = sum(HP lost x unit cost x victim owner's CO value multiplier)   (Kanbei 1.2, Colin 0.8, Hachi 0.9, Hachi powered 0.5)
  //   victim meter += raw (tag CO: floor(raw/2)), attacker meter += raw/2, no gain while that player's own power is on,
  //   clamped at the SCOP cost. Costs already include the +20%-per-use growth (players_co_max_power/spower).
  // Source for "only enemy fire charges": game.js reads copValues only in resolveAttack (5 hits in the file); deleteUnit, explodeUnit
  // and launchSilo never touch the power bar, so deleting your own unit gives no charge. Counter-damage of the attack is ignored.
  const sack = { pid: null, sel: new Map(), base: null, listSig: "", plSig: "", totHtml: "" };
  const unitSel = MP ? 'span[id^="unit_"]' : "span[data-unit-id]";
  const hpOf = (u) => {
    const v = u && u.units_hit_points;
    return typeof v === "number" ? v : /^\d+$/.test(String(v)) ? +v : 0; // "?" (fogged) -> unknown -> not listed
  };
  const ownerOf = (u) => +(u.units_players_id != null ? u.units_players_id : u.players_id);

  function unitIdOfSpan(span) {
    if (!span) return null;
    if (MP) {
      const m = /^unit_(\d+)$/.exec(span.id);
      return m ? m[1] : null;
    }
    return span.getAttribute("data-unit-id");
  }
  function unitSpan(id) {
    return MP ? document.getElementById("unit_" + id) : document.querySelector('#gamemap span[data-unit-id="' + id + '"]');
  }

  // Move Planner: remember the real game state once, so planner edits (HP changes, deletions) can be read as damage.
  function snapBaseline() {
    if (!MP || sack.base || document.readyState !== "complete") return;
    const all = G.unitsInfo();
    if (!all) return;
    const m = new Map();
    for (const id in all) {
      const u = all[id];
      const hp = hpOf(u);
      const cost = num(u.units_cost);
      if (!hp || !cost || u.units_carried === "Y") continue;
      m.set(String(id), { id: String(id), pid: ownerOf(u), name: u.units_name || "Unit", cost, hp, x: u.units_x, y: u.units_y });
    }
    if (m.size) sack.base = m;
  }

  // id -> { id, pid, name, cost, hp (reference HP the loss is measured from), now (current HP; planner: edited HP), x, y }
  function refUnits() {
    const out = new Map();
    const all = G.unitsInfo();
    if (!all) return out;
    if (MP) {
      if (!sack.base) return out;
      for (const [id, b] of sack.base) out.set(id, Object.assign({ now: all[id] ? hpOf(all[id]) : 0 }, b));
      return out;
    }
    for (const id in all) {
      const u = all[id];
      const hp = hpOf(u);
      if (!hp || u.units_carried === "Y") continue;
      out.set(String(id), { id: String(id), pid: ownerOf(u), name: u.units_name || "Unit", cost: num(u.units_cost), hp, now: hp, x: u.units_x, y: u.units_y });
    }
    return out;
  }

  const lossOf = (r) => {
    const v = sack.sel.get(r.id);
    return Math.max(1, Math.min(r.hp, v == null ? r.hp : v));
  };

  // Meter after gaining gainRaw. The tag CO only charges while the main CO's power is off, and gets half (floor).
  function chargeAfter(co, gainRaw, mainOn) {
    if (mainOn !== "N") return co.meter;
    const g = co.kind === "tag" ? Math.floor(gainRaw / 2) : gainRaw;
    return Math.max(co.meter, Math.min(co.scop, co.meter + g));
  }
  const readyOf = (co, meter) => ({ cop: !co.copDisabled && meter >= co.cop, scop: !co.scopDisabled && meter >= co.scop });

  // items: [{cost, hp}] units of player pid with the HP each loses.
  function sackCalc(list, pid, items) {
    const victim = list.find((p) => p.pid === pid);
    if (!victim) return null;
    let hp = 0;
    let funds = 0;
    let raw = 0;
    for (const it of items) {
      hp += it.hp;
      funds += (it.hp * it.cost) / 10;
      raw += it.hp * it.cost * victim.vmult;
    }
    const side = (co) => {
      const after = chargeAfter(co, raw, victim.main.on);
      return { co, before: co.meter, after, gain: after - co.meter };
    };
    const enemies = list
      .filter((q) => q.pid !== pid && q.team !== victim.team && !q.eliminated)
      .map((q) => {
        const after = chargeAfter(q.main, raw / 2, q.main.on);
        return { q, before: q.main.meter, after, gain: after - q.main.meter, rb: readyOf(q.main, q.main.meter), ra: readyOf(q.main, after) };
      });
    return { victim, units: items.length, hp, funds, raw, main: side(victim.main), tag: victim.tag ? side(victim.tag) : null, enemies };
  }

  function needLine(co, meter, which) {
    const dis = which === "cop" ? co.copDisabled : co.scopDisabled;
    if (dis) return "";
    const cost = which === "cop" ? co.cop : co.scop;
    const label = which === "cop" ? "COP" : "SCOP";
    if (meter >= cost) return '<div class="cp-pw"><span class="cp-lbl">' + label + '</span><span class="cp-ok">' + label + ' ready</span> <span class="cp-dim">(cost ' + exact(cost) + ")</span></div>";
    const need = damageNeeded(Object.assign({}, co, { meter }), cost);
    return '<div class="cp-pw"><span class="cp-lbl">' + label + "</span>still needs " + exact(need.needRaw) + " more ≈ <b>" + fmt(need.dealt) + "</b> more dealt OR <b>" + fmt(need.taken) + "</b> more taken</div>";
  }

  function sackSideHtml(label, r, mainOn) {
    const head = mainOn !== "N" ? '<span class="cp-dim">power active: no charge</span>' : "+" + exact(r.gain);
    return (
      '<div class="cp-sside"><b>' + esc(label) + "</b> " + esc(r.co.name) + ": " + head + " · meter " + exact(r.before) + " → <b>" + exact(r.after) + "</b>" +
      needLine(r.co, r.after, "cop") + needLine(r.co, r.after, "scop") + "</div>"
    );
  }

  function sackHtml(res) {
    if (!res || !res.units) return '<div class="cp-dim">Nothing selected.</div>';
    const v = res.victim;
    let h =
      "<div><b>" + res.units + "</b> unit" + (res.units === 1 ? "" : "s") + " · <b>" + res.hp + "</b> HP lost · <b>" + fmt(res.funds) + "</b> funds of damage" +
      (v.vmult !== 1 ? ' <span class="cp-dim">(charge value ×' + v.vmult + " = " + exact(res.raw) + ")</span>" : "") + "</div>";
    h += sackSideHtml(v.name, res.main, v.main.on);
    if (res.tag) h += sackSideHtml("tag", res.tag, v.main.on);
    if (res.enemies.length) {
      h += '<div class="cp-sen"><b>Charges the enemy too</b> <span class="cp-dim">(they gain +50% of the value if they deal it, no counter-damage assumed)</span>';
      for (const e of res.enemies) {
        const co = e.q.main;
        const fresh = (e.ra.cop && !e.rb.cop) || (e.ra.scop && !e.rb.scop);
        const state = e.ra.scop ? "SCOP ready" : e.ra.cop ? "COP ready" : (co.copDisabled ? "" : "COP " + pctOf(e.after, co.cop) + "%") + (co.scopDisabled ? "" : " · SCOP " + pctOf(e.after, co.scop) + "%");
        h +=
          '<div class="cp-sen-row' + (fresh ? " cp-warnrow" : "") + '">' + (fresh ? "⚠ " : "") + esc(e.q.name) + " (" + esc(co.name) + "): " +
          (co.on !== "N" ? "power active, no gain" : "+" + exact(e.gain)) + " → " + exact(e.after) + " · " + state + (fresh ? " <b>new power!</b>" : "") + "</div>";
      }
      h += "</div>";
    }
    return h;
  }

  function sackRowHtml(r) {
    const loss = lossOf(r);
    const planner = MP && r.now < r.hp ? ' <span class="cp-dim">planner: ' + (r.now ? "HP " + r.now : "deleted") + "</span>" : "";
    return (
      '<div class="cp-su" data-id="' + esc(r.id) + '"><input type="checkbox" class="cp-sck"' + (sack.sel.has(r.id) ? " checked" : "") + '><span class="cp-sn">' + esc(r.name) +
      '</span><span class="cp-dim">(' + r.x + "," + r.y + ") HP " + r.hp + planner + '</span><input type="number" class="cp-shp" min="1" max="' + r.hp + '" value="' + loss +
      '" title="HP lost"><span class="cp-sv">' + fmt((loss * r.cost) / 10) + "</span></div>"
    );
  }

  function syncSack(refs, list) {
    const s = ui.sack;
    if (!list || !s.det) return;
    for (const id of [...sack.sel.keys()]) if (!refs.has(id)) sack.sel.delete(id); // destroyed / fogged units
    if (sack.pid == null || !list.some((p) => p.pid === sack.pid)) {
      const v = +G.viewerPId();
      const first = list.find((p) => !p.eliminated) || list[0];
      sack.pid = v && list.some((p) => p.pid === v) ? v : first ? first.pid : null;
    }
    if (MP) {
      let n = 0;
      for (const r of refs.values()) if (r.now < r.hp) n++;
      const label = "Import planner changes (" + n + ")";
      if (s.imp.textContent !== label) s.imp.textContent = label;
      s.imp.disabled = !n;
    }
    if (!s.det.open) return;
    const plSig = list.map((p) => p.pid + p.name + p.main.name).join("|");
    if (plSig !== sack.plSig) {
      sack.plSig = plSig;
      s.pl.innerHTML = list.filter((p) => !p.eliminated).map((p) => '<option value="' + p.pid + '">' + esc(p.name) + " (" + esc(p.main.name) + ")</option>").join("");
    }
    if (s.pl.value !== String(sack.pid)) s.pl.value = String(sack.pid);
    const mine = [...refs.values()].filter((r) => r.pid === sack.pid).sort((a, b) => b.cost * b.hp - a.cost * a.hp || (a.id < b.id ? -1 : 1));
    const listSig = sack.pid + "|" + mine.map((r) => r.id + ":" + r.hp + ":" + r.now).join(",");
    if (listSig !== sack.listSig) {
      sack.listSig = listSig;
      s.list.innerHTML = mine.length ? mine.map(sackRowHtml).join("") : '<div class="cp-dim">No known units for this player.</div>';
    } else {
      for (const row of s.list.querySelectorAll(".cp-su")) {
        const r = refs.get(row.getAttribute("data-id"));
        if (!r) continue;
        const ck = row.querySelector(".cp-sck");
        const inp = row.querySelector(".cp-shp");
        const on = sack.sel.has(r.id);
        if (ck.checked !== on) ck.checked = on;
        if (document.activeElement !== inp && inp.value !== String(lossOf(r))) inp.value = String(lossOf(r));
        row.querySelector(".cp-sv").textContent = fmt((lossOf(r) * r.cost) / 10);
      }
    }
    const items = mine.filter((r) => sack.sel.has(r.id)).map((r) => ({ cost: r.cost, hp: lossOf(r) }));
    const html = G.gameCop() === "N" ? '<div class="cp-dim">CO powers are disabled in this game.</div>' : sackHtml(sackCalc(list, sack.pid, items));
    if (html !== sack.totHtml) {
      sack.totHtml = html;
      s.tot.innerHTML = html;
    }
  }

  // Outline of every ticked unit: a child of the unit's own span, so it follows moves and map zoom.
  function renderMarks(refs) {
    const gm = document.getElementById("gamemap");
    for (const m of document.querySelectorAll(".cp-smark")) {
      const id = unitIdOfSpan(m.parentElement);
      if (!ui.enabled || id == null || !sack.sel.has(id) || !refs.has(id) || !gm.contains(m.parentElement)) m.remove();
    }
    if (!ui.enabled) return;
    for (const id of sack.sel.keys()) {
      const span = unitSpan(id);
      if (!span || !refs.has(id) || !gm.contains(span) || span.querySelector(":scope > .cp-smark")) continue;
      const el = document.createElement("i");
      el.className = "cp-smark";
      span.appendChild(el);
    }
  }

  function tick() {
    snapBaseline();
    render(false);
    const refs = refUnits();
    syncSack(refs, readPlayers());
    renderMarks(refs);
  }

  function unitUnder(e) {
    const gm = document.getElementById("gamemap");
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!gm.contains(el)) continue;
      const span = el.closest(unitSel);
      const id = span && gm.contains(span) ? unitIdOfSpan(span) : null;
      if (id != null) return id;
    }
    return null;
  }

  // Alt+click on a known unit toggles it; everything else (plain clicks, Alt+click elsewhere) is left to the page.
  function altUnit(e) {
    if (!e.altKey || e.button !== 0 || !ui.enabled) return null;
    const id = unitUnder(e);
    return id != null && refUnits().has(id) ? id : null;
  }

  function toggleUnit(id) {
    const r = refUnits().get(id);
    if (!r) return;
    if (sack.sel.has(id)) sack.sel.delete(id);
    else {
      sack.sel.set(id, null);
      sack.pid = r.pid;
    }
    ui.sack.det.open = true;
    tick();
  }

  function importChanges() {
    const refs = refUnits();
    const lostBy = {};
    sack.sel.clear();
    for (const r of refs.values()) {
      const lost = r.hp - r.now;
      if (lost <= 0) continue;
      sack.sel.set(r.id, lost >= r.hp ? null : lost);
      lostBy[r.pid] = (lostBy[r.pid] || 0) + lost * r.cost;
    }
    const best = Object.keys(lostBy).sort((a, b) => lostBy[b] - lostBy[a])[0];
    if (best) sack.pid = +best;
    tick();
  }

  function initSackUI(p) {
    const q = (s) => p.querySelector(s);
    ui.sack = { det: q(".cp-sack"), pl: q(".cp-spl"), list: q(".cp-slist"), tot: q(".cp-stot"), imp: q(".cp-simport") };
    const s = ui.sack;
    if (MP) s.imp.style.display = "";
    s.det.addEventListener("toggle", () => ui.enabled && tick());
    s.pl.addEventListener("change", () => {
      sack.pid = +s.pl.value;
      tick();
    });
    q(".cp-sall").addEventListener("click", () => {
      for (const r of refUnits().values()) if (r.pid === sack.pid) sack.sel.set(r.id, null);
      tick();
    });
    q(".cp-snone").addEventListener("click", () => {
      sack.sel.clear();
      tick();
    });
    s.imp.addEventListener("click", importChanges);
    s.list.addEventListener("change", (e) => {
      if (!e.target.classList.contains("cp-sck")) return;
      const id = e.target.closest(".cp-su").getAttribute("data-id");
      if (e.target.checked) sack.sel.set(id, sack.sel.has(id) ? sack.sel.get(id) : null);
      else sack.sel.delete(id);
      tick();
    });
    s.list.addEventListener("input", (e) => {
      if (!e.target.classList.contains("cp-shp")) return;
      const id = e.target.closest(".cp-su").getAttribute("data-id");
      const r = refUnits().get(id);
      const v = Math.round(+e.target.value);
      if (!r || !isFinite(v) || v < 1) return;
      sack.sel.set(id, v >= r.hp ? null : v);
      tick();
    });
  }

  // ---- live hooks ----------------------------------------------------------------

  const wrappers = new WeakSet();

  function wrap(handlers, name, before, after) {
    const orig = handlers[name];
    if (typeof orig !== "function" || wrappers.has(orig)) return;
    const w = function (res) {
      let ctx;
      try {
        ctx = before && ui.enabled ? before(res) : undefined;
      } catch (err) {
        console.error(LOG, "pre-hook failed", err);
      }
      try {
        return orig.apply(this, arguments);
      } finally {
        try {
          if (after && ui.enabled) after(res, ctx);
        } catch (err) {
          console.error(LOG, "post-hook failed", err);
        }
        schedule();
      }
    };
    wrappers.add(w);
    handlers[name] = w;
  }

  function installHooks() {
    const handlers = window.actionHandlers;
    if (!handlers) return false;
    // Fire: remember the meters before game.js applies copValues, to show the per-fight gain.
    wrap(
      handlers,
      "Fire",
      (res) => {
        const pi = G.playersInfo();
        const cv = res && res.copValues;
        if (!pi || !cv) return null;
        const pre = {};
        for (const role of ["attacker", "defender"]) {
          const c = cv[role];
          if (c && pi[c.playerId]) pre[role] = { pid: +c.playerId, meter: num(pi[c.playerId].players_co_power), on: pi[c.playerId].players_co_power_on !== "N" };
        }
        return pre;
      },
      (res, pre) => {
        const cv = res && res.copValues;
        if (!pre || !cv) return;
        for (const role of ["attacker", "defender"]) {
          const c = cv[role];
          if (!pre[role] || !c) continue;
          const d = pre[role].on ? 0 : (num(c.copValue) - pre[role].meter) / 10;
          ui.last[pre[role].pid] = { d, role: role === "attacker" ? "attacker" : "defender" };
        }
      }
    );
    // Power (meter reset, cost growth, active flag), NextTurn (power off, tag swap, turn marker), and
    // events that change who can act: all re-read the page's own state after game.js has applied them.
    for (const name of ["Power", "NextTurn", "Elimination", "Resign", "GameOver"]) wrap(handlers, name, null, null);
    return true;
  }

  // ---- boot ----------------------------------------------------------------------

  buildUI();
  render(true);
  const gamemapEl = document.getElementById("gamemap");
  gamemapEl.addEventListener(
    "mousedown",
    (e) => {
      if (altUnit(e) != null) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
  gamemapEl.addEventListener(
    "click",
    (e) => {
      const id = altUnit(e);
      if (id == null) return;
      e.stopPropagation();
      e.preventDefault();
      toggleUnit(id);
    },
    true
  );
  if (MP) {
    // No action handlers in the planner: HP edits, deletions and moves are local, so poll a cheap fingerprint
    // (the signature/list checks make an unchanged tick nearly free).
    setInterval(schedule, 400);
  } else {
    // game.js may still be initialising; keep trying briefly, then rely on the poll below.
    (async () => {
      for (let i = 0; i < 50 && !installHooks(); i++) await new Promise((r) => setTimeout(r, 200));
      if (!window.actionHandlers) console.warn(LOG, "actionHandlers not found; live updates rely on polling");
    })();
    // Safety net: the in-page replay viewer, reconnect catch-up and tag swaps replace page state without a handler call
    // we hooked; the signature check makes this free when nothing changed.
    setInterval(schedule, 1000);
  }
})();
