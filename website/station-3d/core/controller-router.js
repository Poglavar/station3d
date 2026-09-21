// Owns the one authoritative Station3D motion controller for a live session.
// Controllers keep their specialised solvers; this router owns only lifecycle,
// semantic action delivery, authoritative pose selection and camera selection.

export const CONTROLLER_METHODS = Object.freeze([
    'activate',
    'handleAction',
    'step',
    'getCameraProfile',
    'requestStop',
    'getExitState',
    'deactivate',
    'dispose',
]);

export function controllerContractMissing(controller) {
    return CONTROLLER_METHODS.filter(method => typeof controller?.[method] !== 'function');
}

export function createControllerRouter() {
    const controllers = new Map();
    let activeId = null;
    let activeController = null;
    let lastPose = null;
    let disposed = false;

    function register(id, controller) {
        const key = String(id || '').trim();
        if (!key) throw new Error('Controller id is required');
        if (disposed) throw new Error('Controller router is disposed');
        if (controllers.has(key)) throw new Error(`Controller already registered: ${key}`);
        const missing = controllerContractMissing(controller);
        if (missing.length > 0) {
            throw new Error(`Controller ${key} is missing: ${missing.join(', ')}`);
        }
        controllers.set(key, controller);
        return controller;
    }

    function activate(id, context = {}, reason = 'switch') {
        if (disposed) return false;
        const key = String(id || '').trim();
        const next = controllers.get(key);
        if (!next) return false;
        if (next === activeController) return true;
        if (next.activate(context) === false) return false;
        const previous = activeController;
        activeId = key;
        activeController = next;
        lastPose = null;
        if (previous) previous.deactivate(reason);
        return true;
    }

    function deactivate(reason = 'deactivate') {
        if (!activeController) return false;
        const previous = activeController;
        activeId = null;
        activeController = null;
        lastPose = null;
        previous.deactivate(reason);
        return true;
    }

    return {
        register,
        has: id => controllers.has(String(id || '').trim()),
        activate,
        deactivate,
        get activeId() { return activeId; },
        get activeController() { return activeController; },
        get lastPose() { return lastPose; },
        handleAction(action, phase = 'press') {
            if (!activeController) return false;
            return activeController.handleAction(action, phase) === true;
        },
        step(dt) {
            if (!activeController) return null;
            const pose = activeController.step(Math.max(0, Number(dt) || 0));
            if (pose) lastPose = pose;
            return pose || null;
        },
        getCameraProfile() {
            return activeController?.getCameraProfile() || null;
        },
        requestStop() {
            return activeController?.requestStop() === true;
        },
        getExitState() {
            return activeController?.getExitState() || null;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (activeController) activeController.deactivate('session-close');
            activeId = null;
            activeController = null;
            lastPose = null;
            for (const controller of controllers.values()) controller.dispose();
            controllers.clear();
        },
    };
}
