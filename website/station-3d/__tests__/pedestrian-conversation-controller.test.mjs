import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createPedestrianConversationController, conversationPairSpatial } from '../core/pedestrian-conversation-controller.js';
import { CONVERSATION_MAX_DISTANCE_M, conversationSpatial, PEDESTRIAN_CONVERSATIONS } from '../core/pedestrian-conversations.js';
import { pedestrianConversationMembers } from '../world/pedestrian-conversation-pair.js';

const listener = (x = 0, y = 1.6, z = 0) => ({ x, y, z, rightX: 1, rightZ: 0 });
const person = x => ({ person: {}, x, y: 1.6, z: 0 });

function harness({ cityId = 'zagreb', random = () => 0, scripts } = {}) {
    const pair = { members: [person(4), person(5)] };
    const pairs = [pair];
    const played = [], updated = [];
    let stops = 0, language = 'hr';
    const controller = createPedestrianConversationController({
        getPairs: () => pairs,
        getMembers: pair => pair.members,
        getLanguage: () => language,
        getCityId: () => cityId,
        playLine: (line, spatial, ended) => { played.push({ line, spatial, ended }); return true; },
        updateLine: spatial => updated.push(spatial),
        stopLine: () => { stops++; },
        random,
        scripts,
    });
    return {
        controller, pair, pairs, played, updated, get stops() { return stops; },
        setLanguage(value) { language = value; },
        setCity(value) { cityId = value; },
    };
}

test('actual playback selects generic clips plus only the current city clips', () => {
    const expected = new Map([
        ['split', ['c2', 'c3', 'c4', 'c5', 'c7', 'c8', 'c9']],
        [null, ['c2', 'c3', 'c4', 'c5']],
        ['unknown', ['c2', 'c3', 'c4', 'c5']],
        ['zagreb', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']],
    ]);
    for (const [cityId, expectedIds] of expected) {
        const selected = new Set();
        for (let index = 0; index < expectedIds.length; index++) {
            const value = (index + 0.1) / expectedIds.length;
            const h = harness({ cityId, random: () => value });
            h.controller.tick(26, listener());
            selected.add(h.controller.snapshot().scriptId);
            assert.equal(h.played.length, 1);
        }
        assert.deepEqual([...selected], expectedIds);
    }
});

test('leaving a city cancels its local chat and then plays generic chatter', () => {
    const h = harness();
    h.controller.tick(10, listener());
    assert.equal(h.controller.snapshot().scriptId, 'c1');
    h.setCity('split');
    h.controller.tick(0.1, listener());
    assert.equal(h.controller.snapshot(), null);
    assert.equal(h.stops, 1);
    h.played[0].ended();
    h.controller.tick(5, listener());
    assert.equal(h.controller.snapshot().scriptId, 'c2');
    assert.equal(h.controller.snapshot().lineIndex, 0);
    h.setCity('zagreb');
    h.controller.tick(0.1, listener());
    assert.equal(h.stops, 1, 'a generic exchange continues across city boundaries');
});

test('a city without eligible scripts stays silent and can recover on entering the matching city', () => {
    const h = harness({ cityId: 'split', scripts: [PEDESTRIAN_CONVERSATIONS[0]] });
    h.controller.tick(10, listener());
    assert.equal(h.played.length, 0);
    assert.equal(h.controller.snapshot(), null);
    h.setCity('zagreb');
    h.controller.tick(5, listener());
    assert.equal(h.controller.snapshot().scriptId, 'c1');
});

test('only a real pair with BOTH members nearby may trigger a conversation', () => {
    const h = harness();
    h.pair.members = [person(1)];
    h.controller.tick(10, listener());
    assert.equal(h.played.length, 0, 'single person');
    const one = person(1);
    h.pair.members = [one, one];
    h.controller.tick(5, listener());
    assert.equal(h.played.length, 0, 'one person referenced twice');
    h.pair.members = [person(9.5), person(10.5)];
    h.controller.tick(5, listener());
    assert.equal(h.played.length, 0, 'one nearby member is insufficient');
    h.pair.members = [person(1), person(8)];
    h.controller.tick(5, listener());
    assert.equal(h.played.length, 0, 'people separated from one another are not a pair');
    h.pair.members = [person(9), person(10)];
    h.controller.tick(5, listener());
    assert.equal(h.played.length, 1, 'two nearby people trigger');
    assert.equal(conversationPairSpatial(h.pair.members, listener(0, 300), { starting: true }), null);
});

test('active speech follows distance, return movement, speaker position and facing every frame', () => {
    const h = harness();
    h.controller.tick(10, listener());
    const initial = h.played[0].spatial;
    h.controller.tick(0.1, listener(-20));
    assert.ok(h.updated.at(-1).gain < initial.gain, 'moving away fades the current line');
    assert.equal(h.played.length, 1, 'the clip is still playing');
    h.controller.tick(0.1, listener());
    assert.equal(h.updated.at(-1).gain, initial.gain, 'returning restores volume');
    h.pair.members.forEach(member => { member.x += 2; });
    h.controller.tick(0.1, listener());
    assert.ok(h.updated.at(-1).gain < initial.gain, 'speaker motion also changes volume');
    h.controller.tick(0.1, { ...listener(), rightX: -1 });
    assert.ok(h.updated.at(-1).pan < 0, 'turning changes the active line stereo position');
    h.played[0].ended();
    h.controller.tick(0.3, listener());
    assert.equal(h.played[1].line.speaker, 'B');
    assert.equal(h.played[1].spatial.distanceM, 7, 'the second person has their own source position');
    h.controller.tick(0.1, listener(-60));
    assert.equal(h.controller.snapshot(), null);
    assert.equal(h.stops, 1, 'the source fades out at the range limit');
});

test('hidden, missing, replaced or removed pair members stop active audio and stale callbacks cannot restart it', () => {
    for (const change of [
        h => { h.pair.members = null; },
        h => { h.pair.members.pop(); },
        h => { h.pair.members[1] = person(5); },
        h => { h.pairs.length = 0; },
    ]) {
        const h = harness();
        h.controller.tick(10, listener());
        change(h);
        h.controller.tick(0.1, listener());
        assert.equal(h.controller.snapshot(), null);
        assert.equal(h.stops, 1);
        h.played[0].ended();
        h.controller.tick(0.1, listener());
        assert.equal(h.played.length, 1);
    }
    const h = harness();
    h.controller.tick(10, listener());
    h.controller.removePair(h.pair);
    assert.equal(h.stops, 1, 'removing a walker stops speech without waiting for a new frame');
    h.controller.tick(5, listener());
    h.played[0].ended();
    assert.equal(h.controller.snapshot().lineIndex, 0, 'old completion cannot advance a new conversation');
    h.controller.stop();
    assert.equal(h.controller.snapshot(), null, 'disabling or ending the layer cancels playback');
});

test('language changes stop the old clip; each subsequent exchange uses the selected language', () => {
    const h = harness();
    h.controller.tick(10, listener());
    assert.match(h.played[0].line.file, /conversations\/c1\//);
    h.setLanguage('en');
    h.controller.tick(0.1, listener());
    assert.equal(h.controller.snapshot(), null);
    h.controller.tick(5, listener());
    assert.match(h.played[1].line.file, /conversations\/en\/c1\//);
    assert.equal(h.played[1].line.text, 'Did you watch Dinamo yesterday?');
});

test('gain reaches zero continuously without a minimum-volume floor', () => {
    const sample = distance => conversationSpatial({ sourceX: distance, sourceZ: 0, cameraX: 0, cameraZ: 0 });
    const gains = [0, 5, 10, 20, 30, 40, 44.99, CONVERSATION_MAX_DISTANCE_M].map(distance => sample(distance).gain);
    assert.ok(gains.every((gain, i) => i === 0 || gain < gains[i - 1]));
    assert.equal(gains.at(-1), 0);
    assert.ok(gains.at(-2) < 0.001);
    assert.equal(sample(CONVERSATION_MAX_DISTANCE_M + 0.01), null);
});

test('world adapter reads actual transformed heads and refuses missing, hidden or detached people', () => {
    const scene = new THREE.Scene(), layer = new THREE.Group(), holder = new THREE.Group();
    scene.add(layer); layer.add(holder);
    holder.position.set(3, 2, 4); holder.rotation.y = Math.PI / 2;
    const people = [-0.4, 0.4].map((x, i) => {
        const mesh = new THREE.Group(); mesh.position.x = x;
        const head = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
        head.name = 'PersonHead'; head.position.y = 1.4 + i * 0.2;
        mesh.add(head); holder.add(mesh); return mesh;
    });
    holder.userData.people = people;
    const walker = { size: 2, targetKind: 'road', mesh: holder };
    const members = pedestrianConversationMembers(walker, scene);
    assert.deepEqual(members.map(m => m.person), people);
    assert.ok(Math.abs(members[0].z - 4.4) < 1e-6);
    assert.ok(Math.abs(members[1].z - 3.6) < 1e-6);
    assert.ok(Math.abs(members[1].y - 3.6) < 1e-6, 'individual head height follows the rendered geometry');
    people[1].visible = false;
    assert.equal(pedestrianConversationMembers(walker, scene), null);
    people[1].visible = true;
    const head = people[1].getObjectByName('PersonHead'); head.visible = false;
    assert.equal(pedestrianConversationMembers(walker, scene), null);
    head.visible = true;
    holder.remove(people[1]);
    assert.equal(pedestrianConversationMembers(walker, scene), null);
    holder.add(people[1]); layer.visible = false;
    assert.equal(pedestrianConversationMembers(walker, scene), null);
    layer.visible = true; scene.remove(layer);
    assert.equal(pedestrianConversationMembers(walker, scene), null);
    scene.add(layer); walker.targetKind = 'inside';
    assert.equal(pedestrianConversationMembers(walker, scene), null);
});
