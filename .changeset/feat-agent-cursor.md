---
"turno-browser": minor
---

The agent cursor: when someone can see the browser (a Chrome window, or the live view), each page shows that an agent is at work and where. A Figma-like arrow with the agent's name and the identity glides to each element it acts on, a ring marks the element, a click leaves a ripple, a field being typed into gets a typing bubble, and a thin frame with a badge ("turno · Claude Code at work", or "paused · you have the controls" while the live view's pause is on) goes around the page while calls run. Several agent sessions on one identity's Chrome each get a cursor and a color of their own, and with humanize on the arrow follows the real pointer path.

It is drawn in a closed shadow root that is out of the accessibility tree, out of the page's text and never a click target, and it is hidden while the model's screenshot is taken, so the model sees the page as before. `turno-browser set <id> --cursor auto|on|off` (identity.json `cursor`, format 12) and `turno-browser-mcp --cursor` choose it: `auto` (the default) draws it when the browser can be seen, and `off` leaves pages exactly as they are.
