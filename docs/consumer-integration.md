# Consuming Station3D

This is the operational checklist for applications such as a transport site,
game or standalone map. The root README contains the full first-use example.

## 1. Install one exact version

```sh
npm install --save-exact station3d@0.1.0-alpha.1
```

Before the registry release, an exact public Git tag is supported:

```sh
npm install --save-exact \
  git+https://github.com/Poglavar/station3d.git#v0.1.0-alpha.1
```

The Git package runs `prepare` to generate its ignored `dist/` before npm packs
it. Never depend on a moving branch. Alternatively, run `npm pack` in
Station3D and install the resulting absolute `.tgz` path. Do not use `npm link`
as release evidence.

## 2. Vendor the browser assets

```sh
npx station3d-vendor --force public/vendor/station3d
```

Run this in the consumer's normal build. Deploy the complete destination
directory; never cherry-pick `index.js` without its chunks, worker scripts,
Draco files, CSS and assets.

## 3. Load and configure

```html
<script src="/vendor/station3d/loader.js"></script>
<script type="module">
  const station3d = await window.__station3DReady;
  station3d.configureWorld({
    id: 'product-world',
    apiBaseUrl: '/api',
    attributions: [{ name: 'OpenStreetMap contributors' }],
    worldProfile: { id: 'product-world', buildings: 'overture' }
  });
  station3d.configureHost({
    name: 'Product name',
    devOverlays: false,
    campaigns: false,
    onExit: () => history.back()
  });
</script>
```

Configuration must happen before the first `open*()` call. For provider fields,
endpoint families and data-licence responsibilities, read
[Provider contract](provider-contract.md).

`campaigns` defaults to `true` because the campaign runtime is a reusable
engine capability. Set it to `false` in planners and inspectors that do not
offer authored play; this removes the campaign entry without forking or
deleting engine behavior used by campaign hosts.

## 4. Open the appropriate mode

```js
station3d.open(lat, lon, label);    // static inspection
station3d.openWalk(lat, lon);       // walking
station3d.openGta(lat, lon);        // road/free-roam
```

`openCab(train, line, poseFn, options)` is for an application that already owns
live rail state. It should be wrapped by a product adapter rather than called
directly throughout product UI code.

Source-data checkers can import `/vendor/station3d/inspection.js` for entity
keys, source metadata, selection state and response normalization. This entry
is a small independent bundle; importing it does not initialize the 3D runtime.

Planning applications can import `/vendor/station3d/planning.js` for named-plan
ID merging and proposal-track conversion. Local scenario launchers can lazily
import `/vendor/station3d/debug.js`. Explorer hosts receive checkpoint-link
parsing through `/vendor/station3d/host.js`. These entries preserve the package
boundary without creating a second Station3D runtime.

Standalone authoring and inspection pages can import
`/vendor/station3d/terrain-tools.js` or `/vendor/station3d/voice-tools.js`.
They expose terrain-viewer and dialogue-preview logic without starting a world
session or adding another render loop.

An authored campaign may build a product distribution with
`station3d-build --overlay-manifest campaign.json --out-dir public/vendor/station3d-campaign --force`.
The manifest maps package-relative `.js` paths to downstream sources. Only
listed paths override the exact installed engine; all other imports resolve
inside Station3D, preventing a copied or duplicate runtime.

## 5. Keep product content downstream

The consuming application owns:

- its navigation, account state and page shell;
- provider URL, bounds, world profile and visible data attribution;
- regional data adapters and private/proxied credentials;
- named structures, local liveries and authored campaigns;
- product-specific analytics and exit behavior.

The engine owns terrain/surface rules, movement, collision, streaming and
generic rendering. Fix those once in Station3D and upgrade consumers to a new
exact version.

## Upgrade procedure

1. Change the exact Station3D dependency version.
2. Run the vendor command again.
3. Build the consumer from a clean install.
4. Exercise every mode the product exposes.
5. Verify the deployed `loader.js` and chunks came from the same version.

Do not retain an old vendored directory after upgrading the package; mixed
versions can load valid JavaScript with incompatible chunks or assets.
