// Optional dialogue-preview helpers for authored-content tooling. Kept out of
// the main runtime so audition/editor pages do not initialize Station3D.

export {
    activeTake,
    conversationFlow,
    playableVoiceIds,
    takeForVoice,
} from './core/campaign-voice-preview-flow.js';
