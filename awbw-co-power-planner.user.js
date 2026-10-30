// ==UserScript==
// @name         AWBW CO Power Planner
// @namespace    awbw-co-power-planner
// @version      1.1.0
// @description  Shows every player's CO power meter, COP/SCOP cost, readiness (now / next turn) and the damage still needed to charge, on Advance Wars By Web (ongoing and finished games).
// @homepageURL  https://github.com/ctrlc03/awbw-assist
// @supportURL   https://github.com/ctrlc03/awbw-assist/issues
// @updateURL    https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-co-power-planner.user.js
// @downloadURL  https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-co-power-planner.user.js
// @match        https://awbw.amarriner.com/game.php*
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
        // a power can be activated at the start of the owner's next turn
        threat: !ended && !eliminated && (copNext || scopNext),
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
      for (const el of document.querySelectorAll(".cp-pchip")) el.remove();
      return;
    }
    render(true);
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
        if (co.on !== "N") when = p.isTurn ? "" : " · chain-usable next turn";
        else when = p.ended ? " · game over" : p.isTurn ? " · usable now" : " · usable on their next turn";
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
    if (p.scopReady) return { cls: "cp-ready-scop", text: p.ended ? "SCOP ✓" : p.isTurn ? "SCOP READY" : "SCOP next turn" };
    if (p.copReady) {
      const sc = m.scopDisabled ? "" : ` · SCOP ${pctOf(m.meter, m.scop)}%`;
      return { cls: "cp-ready", text: (p.ended ? "COP ✓" : p.isTurn ? "COP READY" : "COP next turn") + sc };
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
        render(false);
      } catch (err) {
        console.error(LOG, err);
      }
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
  // game.js may still be initialising; keep trying briefly, then rely on the poll below.
  (async () => {
    for (let i = 0; i < 50 && !installHooks(); i++) await new Promise((r) => setTimeout(r, 200));
    if (!window.actionHandlers) console.warn(LOG, "actionHandlers not found; live updates rely on polling");
  })();
  // Safety net: the in-page replay viewer, reconnect catch-up and tag swaps replace page state without a handler call
  // we hooked; the signature check makes this free when nothing changed.
  setInterval(schedule, 1000);
})();
