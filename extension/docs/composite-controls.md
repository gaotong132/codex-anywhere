# Composite control regression

Clicks on a dropdown or card must not activate a nested remove button. The page agent checks bounded visible points, rejects independent nested actions, and preserves ordinary button icon clicks. A control covered entirely by other actions remains unavailable; the caller can use the intended child's own snapshot ref.

Overflow on an inline wrapper or an ancestor outside a positioned child's containing block can make geometric clipping disagree with the browser. A bounded native hit test can recover a visible fragment. Hidden and private branches remain excluded, and overlays still prevent clicks.

`test/composite-controls.test.ts` covers nested actions, custom unlabeled remove icons, ordinary decoration, clipped content and hidden/private branches. `test/fixtures/composite-controls.html` exercises a real dropdown, a fixed-position plan button and a fixed footer inside clipping ancestors. Console acceptance is separate from this synthetic fixture.
