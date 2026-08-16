# Design QA

Final result: passed

## 2026-08-16 interaction and mobile pass

- Rechecked the camera, recording, clips, editor, and export states at 390 ×
  844 and 320 × 568. Controls remain readable and unclipped at both sizes.
- Removed the duplicate camera-footer Timeline action, clarified local-storage
  status, and added visible camera retry/import recovery actions.
- Replaced ambiguous trim arrows with labeled Start/End frame nudges and
  enlarged timeline clip/trim targets for touch and keyboard use.
- Verified timeline swipe does not change selection, keyboard clip selection
  works, and the playhead follows rendered clip widths and gaps.
- Verified the export modal keeps keyboard focus inside until closed and
  remains usable on the shorter viewport.
- Cross-clip playback handoff measured under 6 ms in the browser run, with the
  incoming clip starting within 0.1 ms of its trim-in point.
- Browser console/page errors: none. Screenshots are in
  `scripts/e2e-out/qa/` after the latest smoke run.

## Visual truth

- Camera source: `/Users/brandontheriot/Downloads/Screenshot 2026-08-15 at 2.35.26 PM.png`
  - Source dimensions: 1290 × 2660 px
  - Source state: live vertical camera, capture controls, clip timeline
- Editor source: `/Users/brandontheriot/Downloads/Screenshot 2026-08-15 at 2.36.00 PM.png`
  - Source dimensions: 1290 × 2396 px
  - Source state: two-clip editor, edit controls, clip timeline
- Camera implementation: `/Users/brandontheriot/Downloads/app/scripts/e2e-out/design-qa/camera-implementation.png`
  - Capture viewport: 430 × 887 CSS px at 3× device scale, cropped by 1 output pixel to 1290 × 2660 px
  - Capture state: live synthetic rear camera, 16:9 selector selected, explicit 9:16 portrait output, no recorded clips
- Editor implementation: `/Users/brandontheriot/Downloads/app/scripts/e2e-out/design-qa/editor-implementation.png`
  - Capture viewport: 430 × 799 CSS px at 3× device scale, cropped by 1 output pixel to 1290 × 2396 px
  - Capture state: two recorded synthetic-camera clips, first clip selected

## Combined comparisons

- Camera comparison: `/Users/brandontheriot/Downloads/app/scripts/e2e-out/design-qa/camera-comparison.png`
- Editor comparison: `/Users/brandontheriot/Downloads/app/scripts/e2e-out/design-qa/editor-comparison.png`

Each comparison places the source on the left and implementation on the right at
the same output dimensions. A separate focused crop was unnecessary because the
full-resolution 3× comparisons keep the top controls, capture deck, edit row,
and timeline legible.

## Fidelity surfaces

- Preserved the dominant full-height camera/preview surface, black chrome,
  high-contrast white controls, prominent capture action, bottom editing row,
  and filmstrip timeline hierarchy.
- Replaced the reference's product-specific header, branding, effects, music,
  and share affordances with Takes-owned framing, zoom status, import, export,
  and local-storage messaging.
- Used the project's Lucide icon set; no Apple source assets, branding, or icons
  were copied.
- The camera empty state intentionally omits a filmstrip until the first clip is
  recorded. The editor comparison uses two clips to match the reference state.

## Comparison history

1. Initial implementation review found 4:3 and 1:1 frames inheriting a
   full-height rule that visibly stretched the capture surface. Fixed by sizing
   16:9 by height and wider ratios by width.
2. Interaction review found the record button could remain disabled after a
   clip save because an internal stopping ref did not trigger a render. Fixed
   with an explicit stopping state tied to save completion.
3. Final combined review at matching pixel widths found no remaining P0, P1, or
   P2 visual issue. Camera controls are unclipped and centered; editor actions
   and timeline remain readable at the shorter reference height.
4. Owner live testing found the portrait contract and hold gesture were not
   sufficiently explicit. The refreshed comparison now shows a visible
   `9:16 portrait` output badge while retaining the requested `16:9` selector;
   touch testing verifies recording remains active only for the held gesture.
5. A compact 320 × 568 regression capture verifies the ratio selector remains
   fully visible with 44 px touch targets. Touch-end and touch-cancel both stop
   recording, and editor media time advances at normal speed without repeated
   seeks from playhead state updates.
