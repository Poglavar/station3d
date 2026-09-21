// Async boundary around the optional weapon subsystem. Cab/walk code can keep
// simple synchronous calls once a capability-bearing session has preloaded it,
// while ordinary tram and walking bundles never fetch weapon meshes/effects.

let implementation = null;
let loading = null;

export function preloadWeaponRuntime() {
    if (implementation) return Promise.resolve(implementation);
    if (!loading) {
        loading = import('../world/weapon.js').then((module) => {
            implementation = module;
            return module;
        }).catch((error) => {
            loading = null;
            throw error;
        });
    }
    return loading;
}

const call = (name, fallback, args) => (
    typeof implementation?.[name] === 'function'
        ? implementation[name](...args)
        : fallback
);

export const setWeaponMount = (...args) => call('setWeaponMount', false, args);
export const isWeaponMounted = (...args) => call('isWeaponMounted', false, args);
export const attachWeapon = (...args) => call('attachWeapon', null, args);
export const detachWeapon = (...args) => call('detachWeapon', undefined, args);
export const setWeaponFiring = (...args) => call('setWeaponFiring', undefined, args);
export const tickWeapon = (...args) => call('tickWeapon', undefined, args);
export const isWeaponAttached = (...args) => call('isWeaponAttached', false, args);
export const setWeaponVisible = (...args) => call('setWeaponVisible', undefined, args);
export const getAmmo = (...args) => call('getAmmo', 0, args);
export const addAmmo = (...args) => call('addAmmo', 0, args);
export const resetAmmo = (...args) => call('resetAmmo', undefined, args);
