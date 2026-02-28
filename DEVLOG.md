# SOLink — Development Log

> A personal diary of building a Web3 messenger from scratch.

# November 24 — Day 1

Started SOLink.

The idea felt clear, but the actual implementation didn't. Solana's web3 stack wasn't really designed for browsers, so the first day turned into a small expedition: polyfilling missing pieces, patching imports, and figuring out how to make the basics even run inside a normal webpage.

At the same time I laid out the foundation for the messenger itself — chat lists, simple UI structure, first design choices. Nothing polished yet, but the direction finally appeared.

# November 25 — Day 2

A day of plumbing.

Most of the work went into making Solana behave reliably in the frontend. Mapping dependencies, adjusting the RPC/WebSocket client, stabilizing reconnect logic — the sort of work no one sees, but everything depends on.

I also refined the chat list, improved text handling, and shaped the interface so it felt less rough. Small steps, but they started forming an actual product instead of a prototype.

# November 27 — Day 3

Redesign.

Took a step back and rebuilt the entire look.
I wanted SOLink to feel like something you'd actually want to use — clean, calm, without unnecessary noise. Reworked layouts, typography, spacing, and adapted everything for mobile. The project finally looked alive instead of experimental.

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
Finished the day by creating a Dev Console to monitor events — something I didn't plan originally, but it already proved useful.

# December 3 — Day 9

Audio Calls and Analytics.

A major milestone — finished implementing end-to-end encrypted audio calls with WebRTC. Completed the signaling system, call manager, and UI components. Calls work peer-to-peer with proper state management, ringtones, and call controls. After days of prototyping and architecture work, everything finally came together.

The Dev Console also grew into a proper dashboard with charts, timelines, and health checks. Made it responsive enough to use on mobile, since I tend to debug everywhere.

# December 4 — Day 10

Icons.

Redrew all icons to match the new SOLink symbol.
Cleaner lines, lighter strokes — small change, but the interface feels more unified now.

# December 5 — Day 11

Documentation.

Started documenting the journey. Created this development log to capture the process — the decisions, the struggles, the small wins that add up over time.

Sometimes stepping back and writing about what you've built helps you see the progress more clearly.

# December 6 — Day 12

Presentation materials.

Built a presentation gallery with SVG cards showcasing SOLink's architecture, security features, and token scanner. Created clean, shareable visuals that explain the project without needing to dive into code.

Also added a Documents section to the README to make these resources easy to find.

# December 7 — Day 13

Audio calls foundation.

Started exploring WebRTC for audio calls. Researched signaling approaches, tested peer-to-peer connection setup, and began sketching the architecture. WebRTC in a browser environment has its quirks — handling ICE candidates, managing connection states, dealing with network changes.

Also updated the wallet identity globe icon and made small visual tweaks. These micro-adjustments might seem minor, but they contribute to that feeling of a finished product rather than a work in progress.

# December 8 — Day 14

Audio calls architecture.

Continued working on the audio calls system. Designed the signaling protocol, planned the call state machine, and started building the WebRTC client wrapper. The challenge is making it work reliably across different network conditions while keeping encryption end-to-end.

Also added a CTA slide to the Documents gallery. Started thinking about how to present SOLink to potential users — not just what it does, but why someone would want to use it.

# December 9 — Day 15

Landing and calls.

Refined the landing page layout and improved the presentation flow. Updated call audio cues to make the calling experience feel more natural.

Also updated project structure documentation — keeping things organized as the codebase grows.

# December 10 — Day 16

Robustness and details.

Improved signaling robustness for audio calls — making sure connections stay stable even when networks are unreliable. Enhanced backup encoding and presentation flow.

Added a small but useful detail: showing token prices with fixed decimals in the UI, so tiny values don't display as scientific notation.

# Summary

Sixteen days of work, and a project that slowly turned from "maybe I can build this" into something people could actually use.

Building SOLink has been less about following a rigid plan and more about exploring — trying things, breaking things, finding better paths, and shaping the product one decision at a time.

The addition of audio calls felt like a major milestone. It's one of those features that transforms a messenger from "nice to have" into "actually useful." Combined with encrypted voice messages, push notifications, cloud sync, and the token scanner, SOLink is starting to feel like a complete product.

There's still a long way ahead, but the foundation feels strong.

