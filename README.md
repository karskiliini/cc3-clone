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

## Controls (as in the original)

- Left click a soldier or a team box: select team. Drag a box on the map: group select.
- Right click: command menu. Hotkeys: **Z** Move, **X** Move Fast, **C** Sneak, **V** Fire,
  **B** Smoke, **N** Defend, **M** Ambush. Shift-click adds waypoints. Esc cancels.
- Hold **Alt** while placing a Fire order: line of sight (bright green clear, dark green obscured, red blocked).
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
