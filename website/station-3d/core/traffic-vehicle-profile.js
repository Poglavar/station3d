// Normalizes visual vehicle metadata into collision dimensions and a shared
// vertical layout without making narrow bicycles inherit passenger-car rules.

export const TRAFFIC_BODY_RIDE_LIFT_M = 0.14;

// The traffic mesh has no wheel arches, so its body must start above the axle
// centre or it visually buries most of each tyre. Wheels remain tangent to the
// road while every body-mounted part shares this lifted datum.
export function trafficVehicleVerticalLayout(type = {}, wheelRadiusM = 0.32) {
    const wheelCenterY = Math.max(0.05, Number(wheelRadiusM) || 0.32);
    const chassisHeightM = Math.max(0, Number(type.chassisH) || 0);
    const cabinHeightM = Math.max(0, Number(type.cabinH) || 0);
    const chassisBottomY = wheelCenterY + TRAFFIC_BODY_RIDE_LIFT_M;
    const beltY = chassisBottomY + chassisHeightM;
    return {
        wheelCenterY,
        chassisBottomY,
        chassisCenterY: chassisBottomY + chassisHeightM * 0.5,
        beltY,
        cabinCenterY: beltY + cabinHeightM * 0.5,
        roofY: beltY + cabinHeightM,
    };
}

export function trafficVehicleDimensions(type = {}) {
    const bicycle = type.kind === 'bicycle';
    return {
        widthM: Math.max(bicycle ? 0.45 : 1.2, Number(type.width) || (bicycle ? 0.55 : 1.8)),
        lengthM: Math.max(bicycle ? 1.6 : 2.4, Number(type.length) || (bicycle ? 1.9 : 4.5)),
        heightM: Math.max(
            bicycle ? 1.45 : 1.1,
            Number(type.height)
                || (Number(type.chassisH || (bicycle ? 0.5 : 0.8))
                    + Number(type.cabinH || (bicycle ? 1.1 : 0.45))),
        ),
    };
}

export function trafficVehicleWheelbaseM(type = {}) {
    const lengthM = trafficVehicleDimensions(type).lengthM;
    const authored = type.wheelbaseM == null ? null : Number(type.wheelbaseM);
    const wheelbaseM = authored != null && Number.isFinite(authored)
        ? authored
        : lengthM * 0.55;
    return Math.max(lengthM * 0.42, Math.min(lengthM * 0.78, wheelbaseM));
}
