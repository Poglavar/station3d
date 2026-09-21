// Coordinates exclusive campaign UI/cinematic control so pausing, input
// clearing, cancellation, and resume each happen exactly once.

export function createControlLeaseManager({ pause = () => {}, resume = () => {}, clearInput = () => {} } = {}) {
    let active = null;
    let sequence = 0;
    const release = (token) => {
        if (!active || token !== active.token) return false;
        active = null;
        // Keys can be pressed while a campaign overlay owns the controls. The
        // corresponding key-up is then consumed by the overlay, leaving walk
        // or vehicle input latched when simulation resumes. Clear at both
        // sides of the lease so closing dialogue can never launch the player.
        clearInput();
        resume();
        return true;
    };
    return {
        acquire(owner) {
            if (active) release(active.token);
            const token = Object.freeze({ id: ++sequence, owner: String(owner || 'campaign') });
            clearInput();
            pause();
            active = { token };
            return token;
        },
        release,
        cancel() {
            return active ? release(active.token) : false;
        },
        current() {
            return active?.token || null;
        },
    };
}
