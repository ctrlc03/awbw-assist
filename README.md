# AWBW Assist

Userscripts for [Advance Wars By Web](https://awbw.amarriner.com) game pages (`game.php`) and the Move Planner (`moveplanner.php?games_id=…`). They work on ongoing and finished games, as a player or a spectator.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Click the install link for each script you want. Tampermonkey opens an install page.

| Script | What it does | Install |
|---|---|---|
| Kill Tracker | Kills and damage dealt per unit: map badges, hover tooltip, sortable table. Builds full history from the game's replay and updates live. In the Move Planner it shows the game's real history. | [install](https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-kill-tracker.user.js) |
| Threat Overlay | Tiles enemy units can attack next turn. Hover an enemy unit to see its reach; hold **Shift** for all enemies, or switch to "Always". In the Move Planner it follows the units as you move, build or delete them. | [install](https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-threat-overlay.user.js) |
| CO Power Planner | Every player's power meter, COP/SCOP cost, and the damage still needed. Warns when an enemy can use a power next turn. **Sack calculator:** tick units (or **Alt+click** them on the map) to see how much charge you'd gain by losing them, and how much it would charge the enemy. In the Move Planner, "Import planner changes" picks up the units you damaged or removed there. | [install](https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-co-power-planner.user.js) |
| Capture Tracker | Captures in progress (points left, turns to finish), income now vs. projected, capture-limit progress. In the Move Planner, captures you plan count toward the projection. | [install](https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-capture-tracker.user.js) |
| Fog Memory | In fog games, a faded marker where each enemy unit was last seen, labelled with the day. The Move Planner shows the same markers (read-only) so you can plan around them. | [install](https://raw.githubusercontent.com/ctrlc03/awbw-assist/main/awbw-fog-memory.user.js) |

If you installed an earlier copy by pasting it into Tampermonkey, install it again from the link above. Only copies installed from the links get updates.

## Updates

Tampermonkey checks the links above periodically (by default about once a day) and installs a new version when the `@version` in the script header increases. To check right away: Tampermonkey Dashboard → select the scripts → **Trigger update**.

For maintainers: bump `@version` in the header with every change, or nobody receives it.

## Panels

- All panels stack at the bottom right. Drag a panel by its title bar to move it anywhere; the position is remembered. **↺** puts it back in the stack.
- **⏻** switches a plugin fully off (no overlays, no background work, no network) until you switch it back on.
- Clicking a title bar collapses or expands the panel.

## Fair play and privacy

- The scripts only use information your browser already receives from AWBW. Nothing hidden by fog is revealed.
- Network requests go only to AWBW itself: the replay endpoint (`api/game/load_replay.php`, the same one the in-game replay viewer uses, one request at a time), the game's damage table (`js/damage_inc.json`), and, in the Move Planner, the game page once to read the funds and capture-limit settings. Nothing is sent anywhere else.
- Data is stored in your browser's local storage for awbw.amarriner.com. The Kill Tracker panel has buttons to delete it.
- AWBW leagues and tournaments may have their own rules about helper tools; check with the organisers before using these there.
