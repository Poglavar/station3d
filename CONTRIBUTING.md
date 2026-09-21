# Contributing to Station3D

Station3D is being separated from a working regional application. Changes to
terrain, surface precedence, roads, rails, collision, movement, streaming and
generic rendering belong in the engine. Regional providers, named structures,
liveries and authored campaigns belong in separate downstream packages.

Before opening a pull request:

```sh
npm ci
npm test
npm run build:station3d
npm run assets:audit
npm run test:package
```

Add deterministic Node tests for behavior whenever possible. Browser-only
logic should remain thin; geometry, scheduling, validation and state changes
should be testable without a DOM or WebGL context.

Do not add media or data without a manifest entry recording its source,
author, license, changes and intended package. The stricter release audit must
pass before publication.
