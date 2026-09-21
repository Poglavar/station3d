// Normalises keyboard/mobile tokens into solver-independent session actions.
// Controllers decide how a semantic action maps onto their specialised input.

export const SESSION_ACTIONS = Object.freeze({
    MOVE_FORWARD: 'move-forward',
    MOVE_BACKWARD: 'move-backward',
    TURN_LEFT: 'turn-left',
    TURN_RIGHT: 'turn-right',
    JETPACK: 'jetpack',
    WALK_BOOST: 'walk-boost',
    THROTTLE: 'throttle',
    BRAKE_REVERSE: 'brake-reverse',
    STEER_LEFT: 'steer-left',
    STEER_RIGHT: 'steer-right',
    RAIL_TURN_LEFT: 'rail-turn-left',
    RAIL_TURN_RIGHT: 'rail-turn-right',
    AIRCRAFT_PITCH_DOWN: 'aircraft-pitch-down',
    AIRCRAFT_PITCH_UP: 'aircraft-pitch-up',
    AIRCRAFT_THROTTLE_UP: 'aircraft-throttle-up',
    AIRCRAFT_THROTTLE_DOWN: 'aircraft-throttle-down',
    AIRCRAFT_THROTTLE_HOLD: 'aircraft-throttle-hold',
    INTERACT: 'interact',
    DOORS: 'doors',
    PARKING_BRAKE: 'parking-brake',
    BELL: 'bell',
    CAMERA: 'camera',
    STOP: 'stop',
    RESET: 'reset',
});

const COMMON = Object.freeze({
    e: SESSION_ACTIONS.INTERACT,
    c: SESSION_ACTIONS.CAMERA,
    r: SESSION_ACTIONS.RESET,
});

export function semanticActionForKey(key, controllerKind = 'foot') {
    const token = String(key || '').toLowerCase();
    if (COMMON[token]) return COMMON[token];
    if (controllerKind === 'foot') {
        return ({
            w: SESSION_ACTIONS.MOVE_FORWARD,
            arrowup: SESSION_ACTIONS.MOVE_FORWARD,
            s: SESSION_ACTIONS.MOVE_BACKWARD,
            arrowdown: SESSION_ACTIONS.MOVE_BACKWARD,
            a: SESSION_ACTIONS.TURN_LEFT,
            arrowleft: SESSION_ACTIONS.TURN_LEFT,
            d: SESSION_ACTIONS.TURN_RIGHT,
            arrowright: SESSION_ACTIONS.TURN_RIGHT,
            ' ': SESSION_ACTIONS.JETPACK,
            shift: SESSION_ACTIONS.WALK_BOOST,
        })[token] || null;
    }
    if (controllerKind === 'rail' || controllerKind === 'train') {
        return ({
            w: SESSION_ACTIONS.THROTTLE,
            arrowup: SESSION_ACTIONS.THROTTLE,
            s: SESSION_ACTIONS.BRAKE_REVERSE,
            arrowdown: SESSION_ACTIONS.BRAKE_REVERSE,
            a: SESSION_ACTIONS.RAIL_TURN_LEFT,
            arrowleft: SESSION_ACTIONS.RAIL_TURN_LEFT,
            d: SESSION_ACTIONS.RAIL_TURN_RIGHT,
            arrowright: SESSION_ACTIONS.RAIL_TURN_RIGHT,
            b: SESSION_ACTIONS.BELL,
            h: SESSION_ACTIONS.PARKING_BRAKE,
        })[token] || null;
    }
    if (controllerKind === 'aircraft') {
        return ({
            w: SESSION_ACTIONS.AIRCRAFT_PITCH_DOWN,
            arrowup: SESSION_ACTIONS.AIRCRAFT_PITCH_DOWN,
            s: SESSION_ACTIONS.AIRCRAFT_PITCH_UP,
            arrowdown: SESSION_ACTIONS.AIRCRAFT_PITCH_UP,
            a: SESSION_ACTIONS.STEER_LEFT,
            arrowleft: SESSION_ACTIONS.STEER_LEFT,
            d: SESSION_ACTIONS.STEER_RIGHT,
            arrowright: SESSION_ACTIONS.STEER_RIGHT,
            ' ': SESSION_ACTIONS.AIRCRAFT_THROTTLE_UP,
            x: SESSION_ACTIONS.AIRCRAFT_THROTTLE_DOWN,
            q: SESSION_ACTIONS.AIRCRAFT_THROTTLE_HOLD,
            b: SESSION_ACTIONS.STOP,
        })[token] || null;
    }
    if (controllerKind === 'boat' && token === ' ') return SESSION_ACTIONS.STOP;
    return ({
        w: SESSION_ACTIONS.THROTTLE,
        arrowup: SESSION_ACTIONS.THROTTLE,
        s: SESSION_ACTIONS.BRAKE_REVERSE,
        arrowdown: SESSION_ACTIONS.BRAKE_REVERSE,
        a: SESSION_ACTIONS.STEER_LEFT,
        arrowleft: SESSION_ACTIONS.STEER_LEFT,
        d: SESSION_ACTIONS.STEER_RIGHT,
        arrowright: SESSION_ACTIONS.STEER_RIGHT,
        b: SESSION_ACTIONS.STOP,
    })[token] || null;
}
