# SOLink — Development Log

> A personal diary of building a Web3 messenger from scratch.

# November 24 — Day 1

Started SOLink.

The idea felt clear, but the actual implementation didn’t. Solana’s web3 stack wasn’t really designed for browsers, so the first day turned into a small expedition: polyfilling missing pieces, patching imports, and figuring out how to make the basics even run inside a normal webpage.

At the same time I laid out the foundation for the messenger itself — chat lists, simple UI structure, first design choices. Nothing polished yet, but the direction finally appeared.

# November 25 — Day 2

A day of plumbing.

Most of the work went into making Solana behave reliably in the frontend. Mapping dependencies, adjusting the RPC/WebSocket client, stabilizing reconnect logic — the sort of work no one sees, but everything depends on.

I also refined the chat list, improved text handling, and shaped the interface so it felt less rough. Small steps, but they started forming an actual product instead of a prototype.

# November 27 — Day 3

Redesign.

Took a step back and rebuilt the entire look.
I wanted SOLink to feel like something you’d actually want to use — clean, calm, without unnecessary noise. Reworked layouts, typography, spacing, and adapted everything for mobile. The project finally looked alive instead of experimental.

# November 28 — Day 4

Details.

Added a favicon, adjusted UI states, and cleaned up edges in the design. Mostly a day of polishing small things that quietly improve the overall feel.

# November 29 — Day 5

PWA and security.

Turned SOLink into an installable app with a proper Service Worker.
Added backup routines, improved CSP rules, wrote legal pages, and tightened up the identity system with a cooldown for nickname changes.

None of this is glamorous, but it makes the project feel real.

# November 30 — Day 6

Reactions and Token Scanner.

Introduced message reactions — simple but satisfying.
Then started working on the Token Scanner feature. Built the backend logic, added UI panels, and made it possible to generate and share reports.

A lot of experimenting this day, jumping between ideas and solutions until everything finally clicked.

# December 1 — Day 7

Push notifications and cloud sync.

Implemented push notifications end to end.
Added a Help Center, privacy pages, and set up R2 cloud sync for backups and scanner history. Moved encryption key generation to a deterministic wallet-based flow, which felt like a big step toward reliability.
UI also got a round of small visual improvements.

# December 2 — Day 8

Voice messages.

Added encrypted voice messages with waveform visualization.
Playback turned out trickier than expected, so I spent time refining the seeking and timing.
Finished the day by creating a Dev Console to monitor events — something I didn’t plan originally, but it already proved useful.

# December 3 — Day 9

Analytics.

The Dev Console grew into a proper dashboard with charts, timelines, and health checks.
Also made it responsive enough to use on mobile, since I tend to debug everywhere.

# December 4 — Day 10

Icons.

Redrew all icons to match the new SOLink symbol.
Cleaner lines, lighter strokes — small change, but the interface feels more unified now.

# Summary

Ten days of work, 135 commits, and a project that slowly turned from “maybe I can build this” into something people could actually use.

Building SOLink has been less about following a rigid plan and more about exploring — trying things, breaking things, finding better paths, and shaping the product one decision at a time.

There’s still a long way ahead, but the foundation feels strong.