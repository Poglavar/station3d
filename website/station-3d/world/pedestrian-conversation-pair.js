import { Vector3 } from 'three';

function visiblyAttachedTo(object, root) {
    for (let node = object; node; node = node.parent) {
        if (!node.visible || node.scale.x === 0 || node.scale.y === 0 || node.scale.z === 0) return false;
        if (node === root) return true;
    }
    return false;
}

// A population record saying "size: 2" is insufficient: both distinct people
// and their heads must still be visible and attached to the active scene.
export function pedestrianConversationMembers(walker, sceneRoot) {
    const holder = walker?.mesh;
    const people = holder?.userData?.people;
    if (walker?.size !== 2 || walker.targetKind === 'inside'
        || !holder || !sceneRoot || !visiblyAttachedTo(holder, sceneRoot)
        || people?.length !== 2 || people[0] === people[1]) return null;
    const heads = people.map(person => person?.getObjectByName?.('PersonHead'));
    if (people.some((person, index) => person?.parent !== holder
        || !heads[index]?.isMesh || !visiblyAttachedTo(heads[index], holder))) return null;
    return heads.map((head, index) => {
        const position = head.getWorldPosition(new Vector3());
        return { person: people[index], x: position.x, y: position.y, z: position.z };
    });
}
