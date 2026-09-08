# Composite control regression

Clicks on a dropdown or card must not activate a nested remove button. The page agent checks bounded visible points, rejects independent nested actions, and preserves ordinary button icon clicks. A control covered entirely by other actions remains unavailable; the caller can use the intended child's own snapshot ref.

Overflow on an inline wrapper or an ancestor outside a positioned child's containing block can make geometric clipping disagree with the browser. A bounded native hit test can recover a visible fragment. Hidden and private branches remain excluded, and overlays still prevent clicks.

`test/composite-controls.test.ts` covers nested actions, custom unlabeled remove icons, ordinary decoration, clipped content and hidden/private branches. `test/fixtures/composite-controls.html` exercises a real dropdown, a fixed-position plan button and a fixed footer inside clipping ancestors. Console acceptance is separate from this synthetic fixture.

The fixture closes its dropdown on viewport resize. Successful native clicks and screenshots now reuse a debugger for the authorized document, releasing it after 60 seconds idle or earlier on navigation, revoke, disconnect or failure. Tests also cover late attachment, user cancellation and a newer document's ownership. This prevents debugger notice resizing from closing a menu immediately after the click. [TinyNG's dropdown source](https://github.com/opentiny/tiny-ng/blob/main/src/drop/lib/src/TiDropComponent.ts) is one example of a real component that closes on position changes.
