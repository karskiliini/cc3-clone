# Close Combat III clone

A fan-made, browser-playable recreation of *Close Combat III: The Russian Front* (1999) written in
TypeScript with HTML5 Canvas 2D and no runtime dependencies. All art, maps, sounds and text are
original and generated procedurally in code. Not affiliated with Microsoft or Atomic Games.

## Run

```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest: sim unit tests + AI-vs-AI balance harness
npm run build
```

## Controls

Classic (as in the original) and modern controls coexist. There is never a default order: pick the
order first (hotkey, order bar, or right-click menu), then click the target.

- Select: left click a soldier or a team box; drag a rectangle on the map for group select;
  Shift adds to the selection; Ctrl+A selects all; double-click a team box to centre on it.
- Orders: press **Z** Move, **X** Move Fast, **C** Sneak, **V** Fire, **B** Smoke, **N** Defend,
  **M** Ambush (or click the order bar in the bottom strip, or right-click for the classic menu),
  then click the target. Shift-click adds waypoints (visited in click order before the final click). Esc cancels.
  Order endpoints stay marked on the map; hover one to see its line to the team, click it to select that team.
- Scroll: two-finger scroll / mouse wheel pans; pinch or Ctrl+wheel zooms around the pointer;
  middle-drag or Space+drag pans; screen edges and the arrow keys scroll too.
- Fire order over an enemy: when the pointer is on a spotted enemy team that one of the selected teams can
  actually shoot at, the cursor becomes a large aiming cross and the enemy's visible men (or hull) are
  bracketed. Against armour the cross shows the chance of the best available gun against the plate it
  would hit from there: **black** will not penetrate, **yellow** might, **green** is likely to; red is for men.
- Hold **Alt** while placing a Fire order: line of sight (bright green clear, dark green obscured, red blocked).
- Unit vision: while teams are selected the map shows what they can see of an enemy standing in the open —
  untouched where he would be spotted for sure, a dark-green tint where only obscured (concealment, distance,
  behind the soldiers' facing), darkened where out of range (300 m ring) or blocked. **L** toggles it
  (also Options → Show Unit Vision); **Shift+L** toggles unit labels.
- Vehicles: a Move order clicked on a friendly halftrack with room makes the team mount it (the vehicle is
  bracketed in green and the pointer says Mount); any new order to the passengers makes them dismount. A crew that
  bailed out can be sent back to its own serviceable vehicle the same way (Re-man), if their nerves allow it.
- Elevation: the ground height under the pointer is always shown beside it, with the height of whatever
  stands there or is dug in (for example `12.4 m +6.0` on a roof, `12.4 m -1.2` in a foxhole).
- Tall grass and crops stand about a metre high and limit sight by that height. Vehicles press them down as
  they drive: ground level under the tracks, a little higher between them; blasts flatten them too. The lanes
  open lines of sight, and show in the depth map and the pointer's elevation.
- **Tab** depth map: the battlefield's surface height as a relief map. The colour ramp spans about
  0-30 m above the datum (blue-violet for holes below ground, through greens and yellows for low ground,
  to orange and red on hilltops and tall buildings), with a green hatch for tree crowns and contours every
  0.5 m below ground and 2 m above. Hills, ridges, valleys and river beds show as broad bands. Craters, foxholes and trenches show as depressions; blasts breach walls,
  flatten hedges and fences and bring buildings down, and the map follows. The vision overlay is hidden
  while it is on. **.** / **,** select the next / previous team.
- **F3** pause, **F5** team data, **F6** inset map, **F7** soldier monitor, **F8** options, **O** overview map,
  **Ctrl+K** toggle corpses, **+ / −** zoom, arrows or screen edge to scroll.
- Bottom strip: Chat, Options, zoom, Map (inset on/off), Truce, Flee.

## Structure

- `src/sim` — deterministic 10 Hz simulation: map, LOS, pathfinding, spotting, combat, morale, AI, victory.
- `src/render` — procedural terrain painter, sprites (soldiers, vehicles, trees, decor), effects, fonts.
- `src/ui` — canvas HUD (team grid, soldier monitor, combat messages, inset map) and poster-style menus.
- `src/data` — weapons, German/Soviet order of battle 1941–45, five maps, the five-battle operation.
- `tools/*.html` — dev preview pages (maps, sprites, effects, UI screens, audio).
- `docs/superpowers/specs` — design spec; `docs/reference` — notes from the original manual;
  `docs/critique` — art critiques used to drive fidelity passes.
