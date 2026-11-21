import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isRoadStructurePublicationKey,
    noteRoadStructureCompiledSource,
    roadReplacementOsmIdsFromRoot,
    roadReplacementPublicationReadyForOsmId,
    roadStructurePublicationKey,
} from '../core/road-replacement-publication.js';

function alignmentModel() {
    const alignment = {
        id: 'osm-composite-split-lower-30166661',
        samples: [],
        memberOsmIds: new Set([30166661, 846828121, 35866854]),
        definition: {
            replaceRoadSurface: true,
            replaceRoadSurfaceOsmIds: ['30166661', '846828121', '35866854'],
        },
    };
    return {
        getAlignmentForOsmId(osmId) {
            return alignment.memberOsmIds.has(Number(osmId)) ? alignment : null;
        },
    };
}

function publishedRoot(replacementIds) {
    return {
        userData: {
            roadVerticalAlignment: {
                replaceRoadSurfaceOsmIds: replacementIds,
            },
        },
    };
}

test('a planned road replacement is not ready until its matching root is active', () => {
    const model = alignmentModel();
    let active = null;
    const surfacePublications = {
        getActive: () => active,
    };
    const options = {
        alignmentModel: model,
        surfacePublications,
        osmId: 35866854,
    };
    assert.equal(roadReplacementPublicationReadyForOsmId({ ...options, surfacePublications: null }), false,
        'a model without an explicit actual-root view cannot authorize ground removal');

    assert.equal(
        roadReplacementPublicationReadyForOsmId(options),
        false,
        'the ordinary solved-profile asphalt remains the backstop while detached geometry builds',
    );
    active = { root: publishedRoot(['30166661', '846828121']) };
    assert.equal(
        roadReplacementPublicationReadyForOsmId(options),
        false,
        'an older partial root cannot suppress a newly owned approach member',
    );
    active = { root: publishedRoot(['30166661', '846828121', '35866854']) };
    assert.equal(roadReplacementPublicationReadyForOsmId(options), false,
        'matching OSM membership without the compiled geometry source is insufficient');
    const alignment = model.getAlignmentForOsmId(35866854);
    noteRoadStructureCompiledSource(active.root, alignment);
    assert.equal(
        roadReplacementPublicationReadyForOsmId(options),
        true,
        'the source member retires only behind its published continuous replacement',
    );
    const newer = { ...alignment, samples: [{ x: 0, y: 5, z: 0 }] };
    assert.equal(roadReplacementPublicationReadyForOsmId({ ...options,
        alignmentModel: { getAlignmentForOsmId: () => newer } }), false,
    'the old deck cannot authorize removal for a new alignment with identical OSM ids');
    assert.equal(roadReplacementPublicationReadyForOsmId({ ...options,
        alignmentModel: { getAlignmentForOsmId: () => ({ ...alignment }) } }), true,
    'a retained query facade shares the exact compiled source');
});

test('road replacement publication identity is shared by producer and consumer', () => {
    assert.equal(
        roadStructurePublicationKey('lower'),
        'roads:structure:lower',
    );
    assert.equal(isRoadStructurePublicationKey('roads:structure:lower'), true);
    assert.equal(isRoadStructurePublicationKey('roads:aggregate:lower'), false);
    assert.deepEqual(
        roadReplacementOsmIdsFromRoot(publishedRoot([35866854, '35866854', 846828121])),
        ['35866854', '846828121'],
    );
});
