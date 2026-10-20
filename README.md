# Blackjack Trainer

Live app: **https://richdow.github.io/blackjack-trainer/** (built for iPhone; works on any modern browser).
This is **play money only**. It has no real-money features of any kind.

It's a casino-accurate blackjack table for learning basic strategy, Hi-Lo counting and how to get ready for a casino.
- Every decision is graded by its exact expected-value cost.
- You can play with AI players, or with friends online at shared tables with chat.

> Nevada law (NRS 465.075) makes it illegal to use a device at a real table to help count or analyze play. This app is for practice away from the table.

## Layout
| Path | What |
|---|---|
| `index.html` | The whole client in one file (built from `src/` by `npm run build`) |
| `src/engine.js` | The rules and the game engine, a pure state machine. The Worker runs the **same** file |
| `src/evcalc.js` | The EV calculator: dealer probabilities and composition-dependent EVs for hit, stand, double, split and surrender (US peek) |
| `src/strategy.js` | Builds the chart from the EV calculator for the active rules. Also holds EV-loss grading, the Illustrious 18 and Fab 4, and the house-edge calculations |
| `src/counting.js` | Hi-Lo running and true count, decks remaining, bet ramp |
| `src/drivers.js` | LocalDriver (AI seats) and NetDriver (WebSocket), which share one interface |
| `src/app.js`, `render.js`, `learn.js`, `drills.js`, `store.js` | The UI, lessons, drills and localStorage |
| `worker/` | The Cloudflare Worker `blackjack-tables` plus Durable Objects (WebSocket Hibernation). The server is authoritative |
| `test/` | Rules, strategy-chart verification against Wizard of Odds, counting, worker integration and Playwright UI tests |
| `shots/` | Screenshots |

## Develop
```sh
npm install
npm run build                      # writes dist/index.html (copy it to ./index.html for Pages)
npm test                           # engine + strategy verification + counting
cd worker && npx wrangler dev --port 8797 --var ALLOWED_ORIGINS:http://127.0.0.1:8768 --var ALLOW_TEST_IP:1
API=http://127.0.0.1:8797 npm run test:worker
(cd dist && python3 -m http.server 8768) & LOCALAPI=1 npm run test:ui
npm run test:cards                 # card legibility geometry: all ranks, 320/390/412/844 widths
```

## Sources
- House-edge effects of rule variations come from Wizard of Odds, "Blackjack Rule Variations": https://wizardofodds.com/games/blackjack/rule-variations/
- Combinatorial EVs and basic-strategy charts come from Wizard of Odds:
  - Appendix 9: https://wizardofodds.com/games/blackjack/appendix/9/
  - Strategy chart images: https://wizardofodds.com/blackjack/images/bj_4d_h17.gif and related files (4-8 deck H17 and S17, 2-deck H17, 1-deck H17), transcribed into `test/fixtures/wizard-charts.js`
  - The tests check the computed charts and EVs against both.
- The Illustrious 18 and Fab 4 Hi-Lo indices come from Don Schlesinger, *Blackjack Attack* (3rd ed.), as republished by Wizard of Odds and countingedge.com.
